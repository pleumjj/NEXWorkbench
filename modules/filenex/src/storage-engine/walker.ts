import { lstat, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { FilenexSettings, IndexedLocation } from '../types';
import type { ArtifactDir, DownloadItem, FolderSize, LargeFile, LocationAnalysis, LooseLogs, RootTotals, Runtime, StorageSettings } from '../storage-types';
import { DOCUMENT_PACKAGE, SKIP_PACKAGE, approvedLocationFor, isInside, isSensitiveName } from '../privacy-engine';
import { classifyDir, isProtectedFile, isSourceFile, markersIn } from './classify';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const LARGE_MIN = 100 * 1024 ** 2;
const MAX_LARGE = 1500;
const MAX_FOLDERS = 400;
const MAX_DOWNLOADS = 2000;
/** Re-measure a known developer folder at most this often when its own mtime has not changed (incremental). */
const REUSE_MS = 24 * 3600_000;

export type WalkOptions = {
  settings: Pick<FilenexSettings, 'locations' | 'includeHidden' | 'excludeSensitive'>;
  storage: Pick<StorageSettings, 'detectDependencies' | 'detectBuildArtifacts'>;
  /** DevNEX project folders inside this location: their totals are accumulated during the walk. */
  watchRoots: string[];
  /** The user's Downloads folder (items at its top level are listed for "old downloads"). */
  downloadsDir: string | null;
  /** Previous analysis of this location — unchanged developer folders are reused instead of re-walked. */
  previous?: LocationAnalysis | null;
  force?: boolean;
  /** Re-checked between batches: false stops immediately (folder removed/paused, storage paused). */
  stillAllowed: () => boolean;
  throttleMs: () => number;
  onProgress?: (entries: number) => void;
  /** Test hook: every directory the walk reads. */
  onVisit?: (dir: string) => void;
  /** Called when the walk enters a watched project root (progress: "12 / 32 repositories"). */
  onRoot?: (path: string) => void;
  /** allocated (default) = disk usage; apparent = byte length. */
  sizeMode?: 'allocated' | 'apparent';
  now?: () => number;
  maxEntries?: number;
};

type RootAcc = RootTotals & { newestMs: number };
type Ctx = { runtimes: Runtime[]; projectRoot: string | null; roots: RootAcc[]; hidden: boolean; sensitive: boolean };

/**
 * Measure one approved location. The walk starts inside it, never follows symlinks, and re-checks every path against
 * the allowlist. Only sizes and dates are read (lstat) — never file contents. Hard-linked files are counted once.
 * Names are recorded only for large files, known developer folders and top-level folders — never for hidden or
 * sensitive names (.env, credentials…), which still count towards their parent's size.
 */
export async function analyzeLocation(loc: IndexedLocation, o: WalkOptions): Promise<LocationAnalysis & { aborted: boolean }> {
  const started = Date.now();
  const now = o.now ?? Date.now;
  const max = o.maxEntries ?? 4_000_000;
  const cmp = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
  const watch = new Map(o.watchRoots.map(p => [cmp(p), p]));
  const downloads = o.downloadsDir ? cmp(o.downloadsDir) : null;
  const prevArtifacts = new Map((o.previous?.artifacts ?? []).map(a => [cmp(a.path), a]));
  const seenInodes = new Set<string>();
  let entries = 0, errors = 0, aborted = false, truncated = false;

  const folders: FolderSize[] = [];
  const artifacts: ArtifactDir[] = [];
  const logs = new Map<string, LooseLogs>();
  const largeFiles: LargeFile[] = [];
  const downloadItems: DownloadItem[] = [];
  const roots: RootAcc[] = [];
  const worktrees: RootAcc[] = [];

  const sizeOf = (st: Stats) => (o.sizeMode === 'apparent' || typeof st.blocks !== 'number' || Number.isNaN(st.blocks) ? st.size : st.blocks * 512);
  /** Hard links (pnpm stores, Time Machine…) count once per walk. */
  const counted = (st: Stats) => {
    if (st.nlink <= 1) return true;
    const key = `${st.dev}:${st.ino}`;
    if (seenInodes.has(key)) return false;
    seenInodes.add(key);
    return true;
  };
  const tick = async () => {
    if (++entries >= max) truncated = true;
    if (entries % 500 === 0) {
      o.onProgress?.(entries);
      await sleep(o.throttleMs());
      if (!o.stillAllowed()) aborted = true;
    }
  };
  const nameable = (name: string, ctx: Ctx) => (o.settings.includeHidden || (!ctx.hidden && !name.startsWith('.')))
    && !(o.settings.excludeSensitive && (ctx.sensitive || isSensitiveName(name)));

  /** Size of a folder measured as one unit (developer artifacts, app bundles). */
  async function measure(dir: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    const stack = [dir];
    while (stack.length && !aborted && !truncated) {
      const d = stack.pop()!;
      let list: import('node:fs').Dirent[];
      try { list = await readdir(d, { withFileTypes: true }); } catch { errors++; continue; }
      for (const e of list) {
        if (aborted || truncated) break;
        if (e.isSymbolicLink()) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) {
          try { const st = await lstat(p); if (counted(st)) { bytes += sizeOf(st); files++; } } catch { errors++; }
        }
        await tick();
      }
    }
    return { bytes, files };
  }

  const addToRoots = (ctx: Ctx, bytes: number, kind: 'source' | 'other' | 'log' | 'artifact', name = '', mtimeMs = 0) => {
    for (const acc of ctx.roots) {
      acc.totalBytes += bytes;
      if (kind === 'source') { acc.sourceBytes += bytes; if (mtimeMs > acc.newestMs) acc.newestMs = mtimeMs; }
      else if (kind === 'other') acc.otherBytes += bytes;
      else if (kind === 'log') acc.looseLogBytes += bytes;
      if (name && isProtectedFile(name)) acc.protectedBytes += bytes;
    }
  };

  async function walk(dir: string, depth: number, parent: Ctx): Promise<number> {
    o.onVisit?.(dir);
    let list: import('node:fs').Dirent[];
    try { list = await readdir(dir, { withFileTypes: true }); } catch { errors++; return 0; }
    const ctx: Ctx = { ...parent };
    const here = markersIn(list.filter(e => e.isFile()).map(e => e.name));
    if (here.length) { ctx.runtimes = [...new Set([...here, ...parent.runtimes])]; ctx.projectRoot = dir; }
    const watched = watch.get(cmp(dir));
    if (watched) {
      const acc: RootAcc = { path: watched, totalBytes: 0, sourceBytes: 0, otherBytes: 0, looseLogBytes: 0, protectedBytes: 0, newestSourceAt: null, newestMs: 0 };
      roots.push(acc);
      o.onRoot?.(watched);
      ctx.roots = [...parent.roots, acc];
      if (!ctx.runtimes.length) ctx.runtimes = ['generic'];
      ctx.projectRoot = ctx.projectRoot ?? dir;
    }
    // A Git worktree: its `.git` is a file pointing at the main repository (Claude Code agent worktrees, `git worktree add`).
    if (!watched && list.some(e => e.name === '.git' && e.isFile())) {
      const acc: RootAcc = { path: dir, totalBytes: 0, sourceBytes: 0, otherBytes: 0, looseLogBytes: 0, protectedBytes: 0, newestSourceAt: null, newestMs: 0 };
      worktrees.push(acc);
      ctx.roots = [...ctx.roots, acc];
      if (!ctx.runtimes.length) ctx.runtimes = ['generic'];
      ctx.projectRoot = ctx.projectRoot ?? dir;
    }
    const isDownloads = downloads !== null && cmp(dir) === downloads;
    let total = 0;
    for (const e of list) {
      if (aborted || truncated) break;
      if (e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      // The boundary: nothing outside an active approved location is measured.
      if (!approvedLocationFor(path, o.settings)) continue;
      let st: Stats;
      try { st = await lstat(path); } catch { errors++; continue; }
      if (e.isDirectory()) {
        let bytes: number;
        const rule = SKIP_PACKAGE.test(e.name) || DOCUMENT_PACKAGE.test(e.name) ? null : classifyDir(e.name, ctx.projectRoot ? ctx.runtimes : [], o.storage);
        if (SKIP_PACKAGE.test(e.name) || DOCUMENT_PACKAGE.test(e.name)) {
          bytes = (await measure(path)).bytes;
          addToRoots(ctx, bytes, 'other');
        } else if (rule) {
          const prev = prevArtifacts.get(cmp(path));
          const mtime = new Date(st.mtimeMs).toISOString();
          const reuse = !o.force && prev && prev.rule === rule.id && prev.modifiedAt === mtime && now() - Date.parse(prev.measuredAt) < REUSE_MS;
          const m = reuse ? { bytes: prev!.bytes, files: prev!.files } : await measure(path);
          if (aborted) break;
          bytes = m.bytes;
          artifacts.push({
            path, name: e.name, rule: rule.id, category: rule.category, runtime: rule.runtime, regeneratable: rule.regeneratable,
            bytes, files: m.files, modifiedAt: mtime, measuredAt: reuse ? prev!.measuredAt : new Date(now()).toISOString(), projectRoot: ctx.projectRoot,
          });
          addToRoots(ctx, bytes, 'artifact');
        } else {
          const hidden = ctx.hidden || e.name.startsWith('.');
          const sensitive = ctx.sensitive || isSensitiveName(e.name);
          bytes = await walk(path, depth + 1, { ...ctx, hidden, sensitive });
        }
        total += bytes;
        if (depth + 1 <= 2 && bytes >= 1024 ** 2 && nameable(e.name, ctx)) folders.push({ path, name: e.name, depth: depth + 1, bytes });
        if (isDownloads && nameable(e.name, ctx)) downloadItems.push({ path, name: e.name, bytes, isDir: true, modifiedAt: new Date(st.mtimeMs).toISOString() });
      } else if (e.isFile()) {
        await tick();
        if (!counted(st)) continue;
        const size = sizeOf(st);
        total += size;
        const isLog = /\.log(\.\d+)?$/i.test(e.name);
        if (isLog) {
          const g = logs.get(dir) ?? { dir, bytes: 0, files: 0, newestAt: null };
          g.bytes += size; g.files++;
          const m = new Date(st.mtimeMs).toISOString();
          if (!g.newestAt || m > g.newestAt) g.newestAt = m;
          logs.set(dir, g);
        }
        addToRoots(ctx, size, isLog ? 'log' : isSourceFile(e.name) || isProtectedFile(e.name) ? 'source' : 'other', e.name, st.mtimeMs);
        if (size >= LARGE_MIN && nameable(e.name, ctx)) {
          largeFiles.push({
            path, name: e.name, extension: extname(e.name).slice(1).toLowerCase(), bytes: size, modifiedAt: new Date(st.mtimeMs).toISOString(),
            createdAt: st.birthtimeMs > 0 ? new Date(st.birthtimeMs).toISOString() : null, inDownloads: downloads !== null && isInside(path, o.downloadsDir!),
          });
        }
        if (isDownloads && nameable(e.name, ctx)) downloadItems.push({ path, name: e.name, bytes: size, isDir: false, modifiedAt: new Date(st.mtimeMs).toISOString() });
      }
    }
    return total;
  }

  const rootCtx: Ctx = { runtimes: [], projectRoot: null, roots: [], hidden: false, sensitive: false };
  const totalBytes = await walk(loc.path, 0, rootCtx);
  o.onProgress?.(entries);
  for (const r of [...roots, ...worktrees]) r.newestSourceAt = r.newestMs ? new Date(r.newestMs).toISOString() : null;

  return {
    locationId: loc.id, path: loc.path, label: loc.label, analyzedAt: new Date(now()).toISOString(), durationMs: Date.now() - started,
    totalBytes, entries, errors, truncated, aborted,
    folders: folders.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_FOLDERS),
    artifacts: artifacts.sort((a, b) => b.bytes - a.bytes),
    logs: [...logs.values()].filter(l => l.bytes >= 1024 ** 2).sort((a, b) => b.bytes - a.bytes).slice(0, 500),
    largeFiles: largeFiles.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_LARGE),
    downloads: downloadItems.sort((a, b) => b.bytes - a.bytes).slice(0, MAX_DOWNLOADS),
    roots: roots.map(({ newestMs: _n, ...r }) => { void _n; return r; }),
    worktrees: worktrees.map(({ newestMs: _n, ...r }) => { void _n; return r; }),
  };
}

/** Folder label for display ("~/Documents/Projects" → "Projects"). */
export const labelOf = (p: string) => basename(p) || p;
/** Path relative to a root, with forward slashes (for display / Git). */
export const relPath = (root: string, p: string) => relative(root, p).split(sep).join('/');

/**
 * Total size of one folder (size only — no names are kept). Used for the opt-in shared package caches.
 * Never follows symlinks; hard links count once; stops when `stillAllowed` turns false.
 */
export async function measureFolder(dir: string, ctl: { stillAllowed: () => boolean; throttleMs: () => number; sizeMode?: 'allocated' | 'apparent' }): Promise<{ bytes: number; files: number; aborted: boolean }> {
  const seen = new Set<string>();
  let bytes = 0, files = 0, n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let list: import('node:fs').Dirent[];
    try { list = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      if (e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          const st = await lstat(p);
          if (st.nlink > 1) { const k = `${st.dev}:${st.ino}`; if (seen.has(k)) continue; seen.add(k); }
          bytes += ctl.sizeMode === 'apparent' || typeof st.blocks !== 'number' ? st.size : st.blocks * 512; files++;
        } catch { /* vanished */ }
      }
      if (++n % 500 === 0) { await sleep(ctl.throttleMs()); if (!ctl.stillAllowed()) return { bytes, files, aborted: true }; }
    }
  }
  return { bytes, files, aborted: false };
}
