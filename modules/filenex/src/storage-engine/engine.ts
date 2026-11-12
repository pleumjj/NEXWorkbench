import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
import { JsonFile } from '@nex/config';
import { exec, type ShellOpen } from '@nex/platform-core';
import type { AttentionItem } from '@nex/shared';
import type { ContextSources, DuplicateGroup, FilenexSettings, WorkContextRef } from '../types';
import type { CleanupCandidate, DiskVolume, DockerStorage, LocationAnalysis, ProjectActivity, RepoStorageSnapshot, RepositoryStorage, SharedCache, StorageCategorySnapshot, StorageSettings, WorktreeGit, WorktreeStorage } from '../storage-types';
import { FilenexError } from '../errors';
import { approvedLocationFor, isInside } from '../privacy-engine';
import { fileId } from '../index-engine';
import { diskVolumes, storageHealth, type StatFs } from '../disk-analyzer';
import { StorageHistory, repoGrowth, storageForecast, storageGrowth } from '../storage-history';
import { buildRepositories, buildWorktrees, devSummary, filterRepos, sortRepos, type DevSort, type GitStates } from '../dev-storage-engine';
import { analyzeLocation, measureFolder, relPath } from './walker';
import { buildCandidates, cleanupPreview, cleanupReportMarkdown, largeFileRisk, recoverySummary } from './cleanup';
import { dockerStorage } from './docker';
import { sharedCacheLocations } from './shared';
import { DEFAULT_STORAGE_SETTINGS, normalizeStorageSettings } from './settings';

const DAY = 86_400_000, HOUR = 3_600_000, GB = 1024 ** 3;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type StorageEngineOptions = {
  dataDir: string;
  home: string;
  /** The FileNEX allowlist — authoritative, read fresh on every check. */
  allowlist: () => FilenexSettings;
  sources: ContextSources;
  duplicates: () => DuplicateGroup[];
  /** Is this path's file in the FileNEX index? (to link Large Files to File detail) */
  indexed?: (id: string) => boolean;
  platform: Pick<ShellOpen, 'openPath' | 'revealPath'>;
  /** Shared system monitor (MemNEX): CPU % and memory pressure. */
  systemLoad?: () => Promise<{ cpu: number; memoryPressure: boolean }>;
  /** The file index is scanning — storage analysis waits so two walks never compete for the disk. */
  indexBusy?: () => boolean;
  emit?: (type: string, data: unknown) => void;
  now?: () => number;
  background?: boolean;
  statfs?: StatFs;
  docker?: () => Promise<DockerStorage>;
  gitPathState?: (repo: string, path: string) => Promise<'ignored' | 'tracked' | 'untracked' | null>;
  worktreeGit?: (path: string) => Promise<WorktreeGit | null>;
  sizeMode?: 'allocated' | 'apparent';
};

type Run = { locationId: string; label: string; entries: number; reposDone: number; reposTotal: number; index: number; of: number; startedAt: string };
type QueueItem = { id: string; force: boolean; manual: boolean };

/** Read-only Git context for one path: ignored / tracked / untracked. Context only — never permission. */
export async function gitPathState(repo: string, path: string): Promise<'ignored' | 'tracked' | 'untracked' | null> {
  const rel = relPath(repo, path);
  if (!rel || rel.startsWith('..')) return null;
  try { await exec('git', ['-C', repo, 'check-ignore', '-q', '--', rel], { timeout: 4000 }); return 'ignored'; }
  catch (e: any) { if (e?.code !== 1) return null; }
  try {
    const { stdout } = await exec('git', ['-C', repo, 'ls-files', '--', rel], { timeout: 6000, maxBuffer: 256 * 1024 });
    return stdout.trim() ? 'tracked' : 'untracked';
  } catch (e: any) { return e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'tracked' : null; }
}

/** Read-only Git facts about a worktree: branch, last commit, number of uncommitted (incl. untracked) files, main repo. */
export async function gitWorktreeInfo(path: string): Promise<WorktreeGit | null> {
  const git = (args: string[], maxBuffer = 256 * 1024) => exec('git', ['-C', path, ...args], { timeout: 6000, maxBuffer }).then(r => r.stdout.trim());
  try {
    const [branch, log, status, common] = await Promise.all([
      git(['branch', '--show-current']).catch(() => ''),
      git(['log', '-1', '--format=%cI%x09%s']).catch(() => ''),
      git(['status', '--porcelain'], 4 * 1024 * 1024),
      git(['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => ''),
    ]);
    const [at, ...subject] = log.split('\t');
    return {
      branch: branch || null, lastCommitAt: at ? new Date(at).toISOString() : null, lastCommitSubject: subject.join('\t') || null,
      uncommitted: status ? status.split('\n').length : 0, mainPath: common && basename(common) === '.git' ? dirname(common) : null,
    };
  } catch { return null; }
}

/**
 * Storage Intelligence for FileNEX. Know where your space went — analyze first, delete deliberately (FileNEX never deletes).
 * Every folder walk is inside an approved FileNEX location; DevNEX registration and WorkNEX activity never grant access.
 */
export class StorageEngine {
  private readonly settingsFile: JsonFile<StorageSettings>;
  private readonly sharedFile: JsonFile<Record<string, { bytes: number; measuredAt: string }>>;
  readonly history: StorageHistory;
  private queue: QueueItem[] = [];
  private working = false;
  private run: Run | null = null;
  private deferred: string | null = null;
  private dirty = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private lastPrune = 0;
  private volCache: { at: number; value: DiskVolume[] } | null = null;
  private dockerCache: { at: number; value: DockerStorage } | null = null;
  private srcCache: { at: number; contexts: WorkContextRef[]; projects: ProjectActivity[] } | null = null;
  private gitCache = new Map<string, { at: number; value: 'ignored' | 'tracked' | 'untracked' | null }>();
  private candCache: { at: number; value: CleanupCandidate[] } | null = null;
  private wtCache = new Map<string, { at: number; value: WorktreeGit | null }>();

  constructor(private readonly opts: StorageEngineOptions) {
    this.settingsFile = new JsonFile(join(opts.dataDir, 'storage-settings.json'), () => ({ ...DEFAULT_STORAGE_SETTINGS }), raw => normalizeStorageSettings(raw));
    this.sharedFile = new JsonFile(join(opts.dataDir, 'shared-caches.json'), () => ({}), raw => (raw && typeof raw === 'object' ? raw as Record<string, { bytes: number; measuredAt: string }> : {}));
    this.history = new StorageHistory(join(opts.dataDir, 'index.sqlite'));
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  private emit(type: string, data: unknown) { try { this.opts.emit?.(type, data); } catch { /* never breaks analysis */ } }
  settings() { return this.settingsFile.get(); }
  private invalidate() { this.candCache = null; }

  /* ───────────── lifecycle ───────────── */

  start() {
    if (this.opts.background === false) return;
    void this.tick(true);
    this.timers.push(setInterval(() => void this.tick(false), 60_000));
    this.timers.forEach(t => t.unref());
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; this.queue = []; this.history.close(); }

  /** Approved, active locations (FileNEX pause and per-folder pause both stop storage analysis). */
  private activeLocations() { const s = this.opts.allowlist(); return s.paused ? [] : s.locations.filter(l => !l.paused); }

  /** Background heartbeat: snapshots, scheduled and debounced analyses, retention. */
  private async tick(_first: boolean) {
    const st = this.settings();
    await this.snapshotIfDue(false).catch(() => {});
    if (this.now() - this.lastPrune > DAY) { this.history.prune(st.historyRetentionDays, this.now()); this.lastPrune = this.now(); }
    if (!st.enabled || st.paused) return;
    const analyzed = new Map(this.history.analyses().map(a => [a.locationId, Date.parse(a.analyzedAt)]));
    for (const l of this.activeLocations()) {
      const last = analyzed.get(l.id);
      if (!last) this.enqueue(l.id);
      else if (st.scanEveryHours && this.now() - last >= st.scanEveryHours * HOUR) this.enqueue(l.id);
      else if (this.dirty.has(l.id) && this.now() - last >= 30 * 60_000) { this.dirty.delete(l.id); this.enqueue(l.id); }
    }
    if (this.queue.length) void this.work();
  }

  /** A watched folder changed (debounced by FileNEX): re-analyze it, at most every 30 minutes. */
  markDirty(locationId: string) { this.dirty.set(locationId, this.now()); }

  enqueue(id: string, opts: { force?: boolean; manual?: boolean } = {}) {
    if (!this.activeLocations().some(l => l.id === id)) return;
    const existing = this.queue.find(q => q.id === id);
    if (existing) { existing.force ||= !!opts.force; existing.manual ||= !!opts.manual; }
    else this.queue.push({ id, force: !!opts.force, manual: !!opts.manual });
    if (this.opts.background !== false) void this.work();
  }

  /** "Analyze now": every approved folder (manual runs are slowed, not deferred, under load). */
  scanAll(force = false) {
    const st = this.settings();
    if (!st.enabled) throw new FilenexError('conflict', 'Storage analysis is turned off in FileNEX › Settings.');
    if (st.paused) throw new FilenexError('conflict', 'Storage analysis is paused. Resume it first.');
    for (const l of this.activeLocations()) this.enqueue(l.id, { force, manual: true });
    if (this.opts.background === false) return this.work().then(() => this.status());
    return this.status();
  }

  private async loadHigh(): Promise<string | null> {
    if (!this.opts.systemLoad) return null;
    const st = this.settings();
    try {
      const l = await this.opts.systemLoad();
      if (st.pauseOnMemoryPressure && l.memoryPressure) return 'memory pressure';
      if (st.pauseOnHighCpu && l.cpu > 85) return 'high CPU load';
    } catch { /* unknown load is not high load */ }
    return null;
  }

  async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    let did = 0;
    const of = () => did + this.queue.length;
    try {
      while (this.queue.length) {
        const st = this.settings();
        if (!st.enabled || st.paused) { this.queue = []; break; }
        if (this.opts.indexBusy?.()) { if (this.opts.background === false) await sleep(50); else break; continue; }
        const item = this.queue[0];
        const why = item.manual ? null : await this.loadHigh();
        if (why) { this.deferred = `Storage analysis paused temporarily due to ${why}.`; break; }
        this.deferred = null;
        this.queue.shift();
        await this.analyze(item.id, item.force, did + 1, of() + 1);
        did++;
      }
      if (did) await this.afterAnalysis(this.queue.length === 0);
    } finally { this.working = false; this.run = null; }
  }

  /** Analyze one approved folder. A removal or pause mid-walk aborts it and discards the partial result. */
  private async analyze(id: string, force: boolean, index: number, of: number): Promise<LocationAnalysis | null> {
    const loc = this.activeLocations().find(l => l.id === id);
    if (!loc || !existsSync(loc.path)) return null;
    const st = this.settings();
    const projects = st.analyzeDevProjects ? (await this.sources()).projects : [];
    const watchRoots = projects.filter(p => isInside(p.path, loc.path) && approvedLocationFor(p.path, this.opts.allowlist())).map(p => p.path);
    const previous = this.history.analyses().find(a => a.locationId === id) ?? null;
    const run: Run = { locationId: id, label: loc.label, entries: 0, reposDone: 0, reposTotal: watchRoots.length, index, of, startedAt: new Date(this.now()).toISOString() };
    this.run = run;
    let slow = false;
    const stillAllowed = () => {
      const s = this.settings();
      return s.enabled && !s.paused && this.activeLocations().some(l => l.id === id && l.path === loc.path);
    };
    const res = await analyzeLocation(loc, {
      settings: this.opts.allowlist(), storage: st, watchRoots, downloadsDir: join(this.opts.home, 'Downloads'), previous, force,
      stillAllowed, throttleMs: () => (slow ? 40 : 2), sizeMode: this.opts.sizeMode, now: () => this.now(),
      onProgress: n => { run.entries = n; if (n % 20_000 < 500) void this.loadHigh().then(w => { slow = !!w; }); },
      onRoot: () => { run.reposDone++; },
    }).catch(() => null);
    if (!res || res.aborted || !stillAllowed()) return null;
    const { aborted: _a, ...analysis } = res;
    void _a;
    this.history.saveAnalysis(analysis);
    this.invalidate();
    this.emit('filenex.storage.analyzed', { label: loc.label, bytes: analysis.totalBytes, durationMs: analysis.durationMs });
    return analysis;
  }

  private async afterAnalysis(complete: boolean) {
    const st = this.settings();
    if (st.sharedCaches) await this.measureShared(false);
    if (!complete) return;
    if (st.historyEnabled) {
      const repos = await this.repositories();
      const ts = new Date(this.now()).toISOString();
      this.history.addRepoSnapshots(repos.filter(r => r.available).map<RepoStorageSnapshot>(r => ({
        projectId: r.projectId, name: r.name, timestamp: ts, totalBytes: r.totalBytes, sourceBytes: r.sourceBytes, dependencyBytes: r.dependencyBytes,
        buildBytes: r.buildBytes, cacheBytes: r.cacheBytes, logBytes: r.logBytes, gitBytes: r.gitBytes, otherBytes: r.otherBytes,
      })));
      await this.snapshotIfDue(true);
    }
  }

  /* ───────────── shared inputs ───────────── */

  private async sources() {
    if (this.srcCache && this.now() - this.srcCache.at < 20_000) return this.srcCache;
    const s = this.opts.sources;
    const [contexts, projects] = await Promise.all([
      s.contexts().catch(() => []),
      s.projectActivity ? s.projectActivity().catch(() => []) : s.projects().then(ps => ps.map(p => ({ ...p, runningServices: 0, status: 'UNKNOWN', composeProjects: [] }))).catch(() => []),
    ]);
    this.srcCache = { at: this.now(), contexts, projects };
    return this.srcCache;
  }

  async volumes(): Promise<DiskVolume[]> {
    if (this.volCache && this.now() - this.volCache.at < 30_000) return this.volCache.value;
    const value = await diskVolumes(this.opts.home, this.opts.statfs);
    this.volCache = { at: this.now(), value };
    return value;
  }

  async docker(force = false): Promise<DockerStorage | null> {
    if (!this.settings().dockerStorage) return null;
    if (!force && this.dockerCache && this.now() - this.dockerCache.at < 10 * 60_000) return this.dockerCache.value;
    const value = await (this.opts.docker ?? (() => dockerStorage(this.now())))();
    this.dockerCache = { at: this.now(), value };
    return value;
  }

  /** Current analyses: only of folders that are still approved (paused folders keep their last result visible). */
  currentAnalyses(): LocationAnalysis[] {
    const allow = this.opts.allowlist();
    return this.history.analyses().filter(a => allow.locations.some(l => l.id === a.locationId && l.path === a.path));
  }

  sharedCaches(): SharedCache[] {
    const measured = this.sharedFile.get();
    const allow = this.opts.allowlist();
    return sharedCacheLocations(this.opts.home).map(c => ({
      ...c, bytes: this.settings().sharedCaches ? measured[c.id]?.bytes ?? null : null, measuredAt: this.settings().sharedCaches ? measured[c.id]?.measuredAt ?? null : null,
      insideApprovedLocation: !!approvedLocationFor(c.path, allow, { includePaused: true }),
    }));
  }

  /** Opt-in: total size of npm/pnpm/yarn caches (size only). */
  async measureShared(force: boolean) {
    if (!this.settings().sharedCaches) return;
    const cur = this.sharedFile.get();
    const next = { ...cur };
    for (const c of sharedCacheLocations(this.opts.home)) {
      if (!force && cur[c.id] && this.now() - Date.parse(cur[c.id].measuredAt) < DAY) continue;
      if (!existsSync(c.path)) { delete next[c.id]; continue; }
      const m = await measureFolder(c.path, { stillAllowed: () => this.settings().sharedCaches && !this.settings().paused, throttleMs: () => 2, sizeMode: this.opts.sizeMode });
      if (m.aborted) return;
      next[c.id] = { bytes: m.bytes, measuredAt: new Date(this.now()).toISOString() };
    }
    this.sharedFile.set(next);
    this.invalidate();
  }

  private async gitStates(paths: { repo: string; path: string }[]): Promise<GitStates> {
    const fn = this.opts.gitPathState ?? gitPathState;
    const out: GitStates = new Map();
    const todo = paths.slice(0, 300);
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async ({ repo, path }) => {
        const c = this.gitCache.get(path);
        if (c && this.now() - c.at < 10 * 60_000) { out.set(path, c.value); return; }
        const value = await fn(repo, path).catch(() => null);
        this.gitCache.set(path, { at: this.now(), value });
        out.set(path, value);
      }));
    }
    return out;
  }

  /** Git facts for every worktree in the current analyses (cached 2 minutes; only paths inside approved folders). */
  private async worktreeGit(): Promise<Map<string, WorktreeGit | null>> {
    const fn = this.opts.worktreeGit ?? gitWorktreeInfo;
    const paths = this.currentAnalyses().flatMap(a => (a.worktrees ?? []).map(w => w.path)).filter(p => approvedLocationFor(p, this.opts.allowlist(), { includePaused: true }));
    const out = new Map<string, WorktreeGit | null>();
    for (let i = 0; i < paths.length; i += 4) {
      await Promise.all(paths.slice(i, i + 4).map(async p => {
        const c = this.wtCache.get(p);
        if (c && this.now() - c.at < 2 * 60_000) { out.set(p, c.value); return; }
        const value = await fn(p).catch(() => null);
        this.wtCache.set(p, { at: this.now(), value });
        out.set(p, value);
      }));
    }
    return out;
  }

  async worktrees(): Promise<WorktreeStorage[]> {
    return buildWorktrees(this.currentAnalyses(), (await this.sources()).projects, await this.worktreeGit(), this.now());
  }

  /** DevNEX projects with their storage footprint (Git-aware risk for each developer folder). */
  async repositories(withGit = true): Promise<RepositoryStorage[]> {
    const st = this.settings();
    const src = await this.sources();
    const analyses = this.currentAnalyses();
    const allow = this.opts.allowlist();
    const docker = await this.docker().catch(() => null);
    const base = { projects: src.projects, analyses, settings: allow, contexts: src.contexts, docker, now: this.now(), worktreeGit: await this.worktreeGit(), inactiveDays: st.inactiveDays, enabled: st.analyzeDevProjects, repoHistory: this.history.repoSnapshots(this.now() - 9 * DAY) };
    if (!withGit) return buildRepositories(base);
    const first = buildRepositories(base);
    const paths = first.filter(r => r.available).flatMap(r => r.breakdown.filter(e => e.container && e.type !== 'git').map(e => ({ repo: r.path, path: e.path })));
    return buildRepositories({ ...base, gitStates: await this.gitStates(paths) });
  }

  async candidates(): Promise<CleanupCandidate[]> {
    if (this.candCache && this.now() - this.candCache.at < 30_000) return this.candCache.value;
    const src = await this.sources();
    const repos = await this.repositories();
    const dayAgo = this.now() - DAY;
    const recentPaths = src.contexts.filter(c => Date.parse(c.lastActiveAt) >= dayAgo).flatMap(c => c.files.map(f => f.path).filter((p): p is string => !!p && isAbsolute(p)));
    const value = buildCandidates({
      repos, analyses: this.currentAnalyses(), projects: src.projects, worktrees: await this.worktrees(), duplicates: this.opts.duplicates(), docker: await this.docker().catch(() => null),
      shared: this.sharedCaches(), recentPaths, now: this.now(),
    });
    this.candCache = { at: this.now(), value };
    return value;
  }

  /* ───────────── snapshots & history ───────────── */

  private onPrimary(path: string) {
    if (process.platform === 'darwin') return !path.startsWith('/Volumes/');
    if (process.platform === 'win32') return parse(path).root.toLowerCase() === parse(this.opts.home).root.toLowerCase();
    return true;
  }

  /** Categories that add up without double counting (shared stores inside a folder are moved out of that folder). */
  private categories(docker: DockerStorage | null, repos: RepositoryStorage[] = []): StorageCategorySnapshot[] {
    const shared = this.sharedCaches().filter(s => s.bytes);
    const cats: StorageCategorySnapshot[] = [];
    for (const a of this.currentAnalyses().filter(x => this.onPrimary(x.path))) {
      const inside = shared.filter(s => isInside(s.path, a.path)).reduce((n, s) => n + (s.bytes ?? 0), 0);
      cats.push({ key: `loc:${a.locationId}`, label: a.label, kind: 'location', bytes: Math.max(0, a.totalBytes - inside) });
      for (const f of a.folders.filter(x => x.depth === 1).slice(0, 12)) cats.push({ key: `folder:${f.path}`, label: f.name, kind: 'folder', bytes: f.bytes });
    }
    for (const r of repos.filter(x => x.available && !x.nested)) cats.push({ key: `repo:${r.projectId}`, label: r.name, kind: 'repo', bytes: r.totalBytes });
    if (docker?.available && !this.dockerInsideApproved()) cats.push({ key: 'docker', label: 'Docker', kind: 'docker', bytes: docker.images.bytes + docker.containers.bytes + docker.volumes.bytes + docker.buildCache.bytes });
    for (const s of shared) cats.push({ key: `shared:${s.id}`, label: s.label, kind: 'shared', bytes: s.bytes! });
    return cats;
  }
  /** Docker Desktop's disk image inside an analyzed folder would be counted twice. */
  private dockerInsideApproved() { return this.opts.allowlist().locations.some(l => isInside(join(this.opts.home, 'Library', 'Containers', 'com.docker.docker'), l.path)); }

  /** About one disk snapshot per hour (with categories after an analysis). Lightweight: a handful of numbers. */
  async snapshotIfDue(withCategories: boolean) {
    const st = this.settings();
    if (!st.historyEnabled) return;
    const last = this.history.lastSnapshotAt();
    if (!withCategories && last && this.now() - last < 55 * 60_000) return;
    const v = (await this.volumes()).find(x => x.primary);
    if (!v) return;
    const cats = withCategories ? this.categories(await this.docker().catch(() => null), await this.repositories(false)) : undefined;
    this.history.addSnapshot({ id: randomUUID().slice(0, 12), timestamp: new Date(this.now()).toISOString(), totalBytes: v.totalBytes, usedBytes: v.usedBytes, freeBytes: v.freeBytes, categories: cats?.length ? cats : undefined });
  }

  /** Deletes FileNEX storage history (optionally the cached analyses). Never touches any file. */
  clearHistory(includeAnalyses: boolean) {
    this.history.clear(includeAnalyses);
    this.invalidate();
    return { ok: true, clearedAnalyses: includeAnalyses, filesTouched: 0 };
  }

  /** Called by FileNEX when a folder stops being approved. A running walk aborts on its next check. */
  locationRemoved(id: string, deleteData: boolean) {
    this.queue = this.queue.filter(q => q.id !== id);
    if (deleteData) this.history.deleteAnalysis(id);
    this.invalidate();
  }

  /* ───────────── read models ───────────── */

  status() {
    const st = this.settings();
    const analyses = this.currentAnalyses();
    const allow = this.opts.allowlist();
    const state = !st.enabled ? 'disabled' : st.paused || allow.paused ? 'paused' : this.run ? (analyses.length ? 'updating' : 'scanning') : this.deferred && this.queue.length ? 'deferred' : this.queue.length ? 'queued' : 'idle';
    return {
      enabled: st.enabled, paused: st.paused, state,
      deferredReason: state === 'deferred' ? this.deferred : null,
      progress: this.run ? { ...this.run } : null,
      queued: this.queue.length,
      lastAnalyzedAt: analyses.map(a => a.analyzedAt).sort().pop() ?? null,
      locations: allow.locations.map(l => { const a = analyses.find(x => x.locationId === l.id); return { id: l.id, label: l.label, path: l.path, paused: l.paused, analyzedAt: a?.analyzedAt ?? null, totalBytes: a?.totalBytes ?? null, truncated: a?.truncated ?? false }; }),
      configured: allow.locations.length > 0,
      history: this.history.counts(),
    };
  }

  async health() {
    const st = this.settings();
    const volume = (await this.volumes()).find(v => v.primary) ?? null;
    const snaps = this.history.snapshots(this.now() - 30 * DAY);
    const forecast = volume ? storageForecast(snaps, this.now(), volume.totalBytes) : { enough: false, message: 'Disk information is not available.' };
    const health = volume ? storageHealth(volume, st.thresholds, forecast) : null;
    return { volume, health, forecast, snaps };
  }

  async overview() {
    const { volume, health, forecast, snaps } = await this.health();
    const volumes = await this.volumes();
    const docker = await this.docker().catch(() => null);
    const repos = await this.repositories(false);
    const cats = this.categories(docker, repos);
    const items = cats.filter(c => c.kind === 'location' || c.kind === 'docker' || c.kind === 'shared').map(c => ({
      ...c, estimate: c.kind === 'docker',
      note: c.kind === 'docker' ? 'Reported by Docker (inside its own disk image)' : c.kind === 'shared' ? 'Shared package cache' : 'Approved FileNEX folder · measured',
      folders: c.kind === 'location' ? cats.filter(f => f.kind === 'folder' && this.currentAnalyses().some(a => `loc:${a.locationId}` === c.key && isInside(f.key.slice(7), a.path))).slice(0, 4) : [],
    })).sort((a, b) => b.bytes - a.bytes);
    const analyzed = items.reduce((n, x) => n + x.bytes, 0);
    const recovery = recoverySummary(await this.candidates());
    return {
      volume, volumes, health, forecast,
      growth: storageGrowth(snaps, this.now(), 7),
      distribution: volume ? { usedBytes: volume.usedBytes, analyzedBytes: analyzed, items, notAnalyzedBytes: Math.max(0, volume.usedBytes - analyzed) } : null,
      recovery, docker, status: this.status(),
      devTotalBytes: repos.filter(r => r.available && !r.nested).reduce((n, r) => n + r.totalBytes, 0),
    };
  }

  async largeFiles(minMb = this.settings().largeFileThresholdMb, sort: 'largest' | 'oldest' | 'newest' | 'recent' | 'location' = 'largest') {
    const min = Math.max(1, minMb) * 1024 ** 2;
    const files = this.currentAnalyses().flatMap(a => a.largeFiles.map(f => ({ ...f, locationLabel: a.label })))
      .filter(f => f.bytes >= min)
      .map(f => { const r = largeFileRisk(f); const id = fileId(f.path); return { ...f, risk: r.risk, reason: r.reason, fileId: this.opts.indexed?.(id) ? id : null }; });
    const by: Record<string, (a: typeof files[number], b: typeof files[number]) => number> = {
      largest: (a, b) => b.bytes - a.bytes, oldest: (a, b) => a.modifiedAt.localeCompare(b.modifiedAt), newest: (a, b) => b.modifiedAt.localeCompare(a.modifiedAt),
      recent: (a, b) => (b.createdAt ?? b.modifiedAt).localeCompare(a.createdAt ?? a.modifiedAt), location: (a, b) => a.path.localeCompare(b.path),
    };
    files.sort(by[sort] ?? by.largest);
    return { thresholdMb: minMb, total: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), files: files.slice(0, 500), analyzedLocations: this.currentAnalyses().length };
  }

  async growth(days = 7) {
    const { volume, forecast } = await this.health();
    const all = this.history.snapshots(this.now() - Math.max(days, 30) * DAY);
    const daily = new Map<string, number>();
    for (const s of all) { const d = new Date(s.timestamp); daily.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, s.usedBytes); }
    const repoRows = this.history.repoSnapshots(this.now() - (days + 1) * DAY);
    const repos = [...new Set(repoRows.map(r => r.projectId))].map(id => {
      const rows = repoRows.filter(r => r.projectId === id);
      const g = repoGrowth(rows, this.now(), days);
      return g ? { projectId: id, name: rows[rows.length - 1].name, ...g } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.deltaBytes - a.deltaBytes);
    return { days, volume, growth: storageGrowth(all, this.now(), days), forecast, daily: [...daily.entries()].slice(-30).map(([day, usedBytes]) => ({ day, usedBytes })), repos, historyEnabled: this.settings().historyEnabled, snapshots: all.length };
  }

  async developer(q = '', sort: DevSort = 'largest') {
    const repos = await this.repositories();
    const st = this.settings();
    const summary = devSummary(repos, this.sharedCaches());
    const docker = await this.docker().catch(() => null);
    return {
      enabled: st.analyzeDevProjects, summary, docker, sharedEnabled: st.sharedCaches,
      repos: sortRepos(filterRepos(repos, q), sort).map(r => ({ ...r, breakdown: [] })),
      growth: repos.filter(r => (r.growth7dBytes ?? 0) > 0).sort((a, b) => (b.growth7dBytes ?? 0) - (a.growth7dBytes ?? 0)).slice(0, 8).map(r => ({ projectId: r.projectId, name: r.name, growth7dBytes: r.growth7dBytes })),
      status: this.status(),
    };
  }

  async developerDetail(projectId: string) {
    const repos = await this.repositories();
    const repo = repos.find(r => r.projectId === projectId);
    if (!repo) throw new FilenexError('not_found', 'This DevNEX project is not available.');
    const git = repo.available && this.opts.sources.git ? await this.opts.sources.git(repo.path).catch(() => null) : null;
    const growth = repoGrowth(this.history.repoSnapshots(this.now() - 8 * DAY, projectId), this.now(), 7);
    const st = this.settings();
    const old = repo.available && !repo.isActiveProject && repo.runningServiceCount === 0 && (repo.inactiveDays ?? 0) >= st.inactiveDays;
    return { repo, git, growth, old, gitClean: git ? git.changed === 0 && git.untracked === 0 : null, inactiveThresholdDays: st.inactiveDays };
  }

  async cleanupPreview(ids: unknown) {
    if (!Array.isArray(ids) || !ids.length || ids.some(x => typeof x !== 'string')) throw new FilenexError('bad_request', 'Choose at least one item to preview.');
    return cleanupPreview(await this.candidates(), ids as string[]);
  }

  /** Markdown report for an assistant to continue the cleanup with the user (selection, or a risk / project filter). */
  async cleanupReport(opts: { ids?: string[]; risk?: string | null; project?: string | null } = {}) {
    let cands = await this.candidates();
    const scope: string[] = [];
    if (opts.ids?.length) { const set = new Set(opts.ids); cands = cands.filter(c => set.has(c.id)); scope.push(`${cands.length} selected item(s)`); }
    if (opts.risk) { cands = cands.filter(c => c.risk === opts.risk); scope.push(`risk ${opts.risk}`); }
    if (opts.project) { cands = cands.filter(c => c.projectId === opts.project); scope.push(`project ${cands[0]?.projectName ?? opts.project}`); }
    const { volume, health } = await this.health();
    return cleanupReportMarkdown(cands, {
      now: this.now(), scope: scope.join(', ') || 'all cleanup candidates',
      disk: volume && health ? { label: volume.label, freeBytes: volume.freeBytes, totalBytes: volume.totalBytes, status: health.status } : null,
    });
  }

  /** Open / reveal a path FileNEX reported (large file, candidate, repository) — never anything else. */
  private async allowedPath(path: unknown): Promise<string> {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new FilenexError('bad_request', 'A full path is required.');
    const known = this.currentAnalyses().some(a => a.largeFiles.some(f => f.path === path) || a.downloads.some(d => d.path === path))
      || (await this.candidates()).some(c => c.path === path)
      || (await this.repositories(false)).some(r => r.available && r.path === path);
    if (!known) throw new FilenexError('forbidden', 'FileNEX only opens items it found in your approved folders.');
    const shared = this.sharedCaches().some(s => s.path === path && this.settings().sharedCaches);
    if (!shared && !approvedLocationFor(path, this.opts.allowlist(), { includePaused: true })) throw new FilenexError('forbidden', 'This folder is no longer approved in FileNEX.');
    if (!existsSync(path)) throw new FilenexError('not_found', 'It is no longer there — the next analysis updates the list.');
    return path;
  }
  async open(path: unknown) { const p = await this.allowedPath(path); await this.opts.platform.openPath(p).catch(e => { throw new FilenexError('unprocessable', (e as Error).message); }); return { ok: true }; }
  async reveal(path: unknown) { const p = await this.allowedPath(path); await this.opts.platform.revealPath(p).catch(e => { throw new FilenexError('unprocessable', (e as Error).message); }); return { ok: true }; }

  pause() { this.settingsFile.set({ ...this.settings(), paused: true }); this.queue = []; this.emit('filenex.storage.paused', {}); return this.status(); }
  resume() { this.settingsFile.set({ ...this.settings(), paused: false }); this.emit('filenex.storage.resumed', {}); void this.tick(false); return this.status(); }
  updateSettings(patch: unknown) {
    const before = this.settings();
    const next = normalizeStorageSettings({ ...before, ...(patch && typeof patch === 'object' ? patch : {}) }, before);
    this.settingsFile.set(next);
    if (!next.enabled || next.paused) this.queue = [];
    if (!next.sharedCaches && before.sharedCaches) this.sharedFile.set({});
    if (next.sharedCaches && !before.sharedCaches && this.opts.background !== false) void this.measureShared(true);
    if (next.historyRetentionDays !== before.historyRetentionDays) this.history.prune(next.historyRetentionDays, this.now());
    this.invalidate();
    return next;
  }

  /* ───────────── Workbench integration ───────────── */

  /** Compact numbers for the module card. */
  async summary() {
    const { volume, health } = await this.health();
    const analyzed = this.currentAnalyses().length > 0;
    const recovery = analyzed ? recoverySummary(await this.candidates()).totalBytes : null;
    return { freeBytes: volume?.freeBytes ?? null, totalBytes: volume?.totalBytes ?? null, status: health?.status ?? null, recoveryBytes: recovery };
  }

  /** Meaningful only: low/critical disk space, and at most one repository that grew a lot this week. */
  async attention(): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const t = new Date(this.now()).toISOString();
    const { volume, health } = await this.health();
    if (volume && health && (health.status === 'low' || health.status === 'critical')) {
      items.push({
        id: `filenex:storage:${health.status}`, sourceModule: 'FileNEX', severity: health.status === 'critical' ? 'critical' : 'warning',
        title: health.status === 'critical' ? 'Disk space is critically low' : 'Disk space is low',
        description: `${(volume.freeBytes / GB).toFixed(1)} GB free of ${(volume.totalBytes / GB).toFixed(0)} GB. ${health.reasons.slice(1).join(' ')}`.trim(),
        action: '/filenex/storage', actionLabel: 'Review Storage', timestamp: t,
      });
    }
    if (this.settings().analyzeDevProjects) {
      const repos = await this.repositories(false);
      const grew = repos.map(r => ({ r, g: repoGrowth(this.history.repoSnapshots(this.now() - 8 * DAY, r.projectId), this.now(), 7) }))
        .filter(x => x.g && x.g.deltaBytes >= 3 * GB && x.g.deltaBytes >= 0.2 * x.g.fromBytes).sort((a, b) => b.g!.deltaBytes - a.g!.deltaBytes)[0];
      if (grew) {
        items.push({
          id: `filenex:storage:growth:${grew.r.projectId}`, sourceModule: 'FileNEX', severity: 'info',
          title: `${grew.r.name} grew by ${(grew.g!.deltaBytes / GB).toFixed(1)} GB this week`,
          description: `Largest contributors: ${grew.g!.parts.filter(p => p.deltaBytes > 0).slice(0, 2).map(p => p.label).join(', ') || 'project files'}.`,
          action: `/filenex/storage/developer/${encodeURIComponent(grew.r.projectId)}`, actionLabel: 'Review Developer Storage', timestamp: t,
        });
      }
    }
    return items;
  }
}
