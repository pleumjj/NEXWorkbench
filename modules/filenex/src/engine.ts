import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { JsonFile } from '@nex/config';
import type { AppControl, ShellOpen } from '@nex/platform-core';
import type { Collection, ContextSources, DuplicateGroup, FileRecord, FilenexSettings, IndexedLocation, LocationStatus, ProjectRef, RelatedFile, SearchHit, VersionGroup, WorkContextRef } from './types';
import { FilenexError } from './errors';
import { DEFAULT_SETTINGS, approvedLocationFor, isBroadFolder, isInside, locationId, normalizeSettings, validateLocationPath } from './privacy-engine';
import { FileStore, hashFile, scanLocation } from './index-engine';
import { search, type SearchFilters } from './search-engine';
import { contextsOf, projectOf, relatedFiles } from './relationship-engine';
import { buildVersionGroups, versionIndex } from './version-engine';
import { buildDuplicateGroups, hashCandidates } from './duplicate-engine';
import { StorageEngine, type StorageEngineOptions } from './storage-engine';

export type FilenexEngineOptions = {
  platform: ShellOpen & Pick<AppControl, 'launch'>;
  dataDir: string;
  /** WorkNEX contexts + DevNEX projects (wired by the Workbench). Neither grants indexing permission. */
  sources: ContextSources;
  /** Shared system pressure (MemNEX/system core): true → slow down / defer background indexing. */
  systemBusy?: () => Promise<boolean>;
  emit?: (type: string, data: unknown) => void;
  home?: string;
  now?: () => number;
  /** Shared system monitor detail (MemNEX): CPU % and memory pressure — storage analysis defers under load. */
  systemLoad?: () => Promise<{ cpu: number; memoryPressure: boolean }>;
  /** Disable timers/watchers (tests drive scans explicitly). */
  background?: boolean;
  /** Storage engine overrides (tests: statfs, docker, git, apparent sizes). */
  storage?: Partial<Pick<StorageEngineOptions, 'statfs' | 'docker' | 'gitPathState' | 'worktreeGit' | 'sizeMode'>>;
};

type RunState = { state: LocationStatus['state']; scanned: number; lastScanAt: string | null; error: string | null };
const MAX_HASH_PER_PASS = 400;

/** FileNEX business logic behind one facade. The API layer only routes HTTP here. */
export class FilenexEngine {
  private readonly settingsFile: JsonFile<FilenexSettings>;
  private readonly runFile: JsonFile<Record<string, { lastScanAt: string | null }>>;
  readonly store: FileStore;
  /** Storage Intelligence — same allowlist, same sources, its own history. */
  readonly storage: StorageEngine;
  private readonly runs = new Map<string, RunState>();
  private readonly queue: string[] = [];
  private working = false;
  private hashing = false;
  private watchers = new Map<string, FSWatcher>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private timers: NodeJS.Timeout[] = [];
  private rev = 0;
  private derived: { rev: number; versions: VersionGroup[]; duplicates: DuplicateGroup[] } | null = null;
  private sourceCache: { at: number; contexts: WorkContextRef[]; projects: ProjectRef[] } | null = null;
  private readonly home: string;

  constructor(private readonly opts: FilenexEngineOptions) {
    this.home = opts.home ?? homedir();
    this.settingsFile = new JsonFile(join(opts.dataDir, 'settings.json'), () => ({ ...DEFAULT_SETTINGS }), raw => normalizeSettings(raw));
    this.runFile = new JsonFile(join(opts.dataDir, 'scans.json'), () => ({}), raw => (raw && typeof raw === 'object' ? raw as Record<string, { lastScanAt: string | null }> : {}));
    this.store = new FileStore(join(opts.dataDir, 'index.sqlite'));
    this.storage = new StorageEngine({
      dataDir: opts.dataDir, home: this.home, allowlist: () => this.settings(), sources: opts.sources,
      duplicates: () => this.duplicates(), indexed: id => !!this.store.get(id), platform: opts.platform,
      systemLoad: opts.systemLoad, indexBusy: () => this.working, emit: opts.emit, now: opts.now, background: opts.background,
      ...opts.storage,
    });
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  private emit(type: string, data: unknown) { try { this.opts.emit?.(type, data); } catch { /* listeners never break indexing */ } }
  settings() { return this.settingsFile.get(); }
  private changed() { this.rev++; }

  /* ───────────── lifecycle ───────────── */

  start() {
    for (const l of this.settings().locations) this.runs.set(l.id, { state: 'idle', scanned: 0, lastScanAt: this.runFile.get()[l.id]?.lastScanAt ?? null, error: null });
    if (this.opts.background === false) return;
    // First scan of never-scanned locations; later scans are periodic reconciliation + file watching.
    for (const l of this.activeLocations()) if (!this.runs.get(l.id)?.lastScanAt) this.enqueue(l.id);
    this.timers.push(setInterval(() => this.periodic(), 60_000));
    this.timers.forEach(t => t.unref());
    this.syncWatchers();
    this.storage.start();
  }
  stop() {
    this.storage.stop();
    this.timers.forEach(clearInterval); this.timers = [];
    this.watchers.forEach(w => w.close()); this.watchers.clear();
    this.debounce.forEach(clearTimeout); this.debounce.clear();
    this.store.close();
  }

  private activeLocations() { const s = this.settings(); return s.paused ? [] : s.locations.filter(l => !l.paused); }

  /** Periodic reconciliation (only for locations whose last scan is older than the chosen interval). */
  private async periodic() {
    const s = this.settings();
    if (s.paused || !s.scanEveryMinutes) return;
    if (s.deferUnderPressure && await this.busy()) return; // background work waits for a calmer moment
    for (const l of this.activeLocations()) {
      const last = this.runs.get(l.id)?.lastScanAt;
      if (!last || this.now() - Date.parse(last) >= s.scanEveryMinutes * 60_000) this.enqueue(l.id);
    }
  }

  private async busy() { try { return (await this.opts.systemBusy?.()) ?? false; } catch { return false; } }

  /** Watch approved folders only; any change re-scans that folder after a quiet period. */
  private syncWatchers() {
    if (this.opts.background === false) return;
    const s = this.settings();
    const want = new Set(s.watchChanges ? this.activeLocations().map(l => l.id) : []);
    for (const [id, w] of this.watchers) if (!want.has(id)) { w.close(); this.watchers.delete(id); }
    for (const l of this.activeLocations()) {
      if (!want.has(l.id) || this.watchers.has(l.id)) continue;
      try {
        const w = watch(l.path, { recursive: true, persistent: false }, () => {
          clearTimeout(this.debounce.get(l.id));
          const t = setTimeout(() => { this.enqueue(l.id); this.storage.markDirty(l.id); }, 15_000);
          t.unref();
          this.debounce.set(l.id, t);
        });
        w.on('error', () => { w.close(); this.watchers.delete(l.id); });
        this.watchers.set(l.id, w);
      } catch { /* watching is an optimisation; periodic scans still run */ }
    }
  }

  enqueue(id: string) {
    if (this.opts.background === false) return; // tests drive scans explicitly
    if (!this.queue.includes(id)) this.queue.push(id);
    void this.work();
  }

  /** One scan at a time. Removal/pause mid-scan aborts it and discards its partial results. */
  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        await this.scan(id);
      }
    } finally { this.working = false; }
    void this.hashPass();
  }

  /** Scan one location now (also used by tests). */
  async scan(id: string): Promise<void> {
    const loc = this.activeLocations().find(l => l.id === id);
    if (!loc) return;
    const run = this.runs.get(id) ?? { state: 'idle', scanned: 0, lastScanAt: null, error: null };
    this.runs.set(id, run);
    if (!existsSync(loc.path)) { Object.assign(run, { state: 'unavailable', error: 'Folder not found — it may have been moved, or a drive is disconnected.' }); return; }
    Object.assign(run, { state: 'scanning', scanned: 0, error: null });
    let slow = false;
    const stillAllowed = () => this.activeLocations().some(l => l.id === id);
    const result = await scanLocation(loc, this.settings(), {
      stillAllowed,
      throttleMs: () => (slow ? 60 : 3),
      onProgress: n => { run.scanned = n; if (n % 2000 < 250) void this.busy().then(b => { slow = b && this.settings().deferUnderPressure; }); },
    }).catch(e => { Object.assign(run, { state: 'error', error: (e as Error).message }); return null; });
    if (!result) return;
    if (result.aborted || !stillAllowed()) { run.state = this.settings().locations.some(l => l.id === id) ? 'paused' : 'idle'; return; }

    // Reconcile: write only what changed, drop records of files that disappeared from this location.
    const existing = new Map(this.store.all().filter(f => f.locationId === id).map(f => [f.id, f]));
    const seen = new Set(result.records.map(r => r.id));
    const changed = result.records.filter(r => { const old = existing.get(r.id); return !old || old.sizeBytes !== r.sizeBytes || old.modifiedAt !== r.modifiedAt || old.path !== r.path; });
    const gone = [...existing.keys()].filter(fid => !seen.has(fid));
    this.store.upsert(changed);
    this.store.remove(gone);
    if (changed.length || gone.length) this.changed();
    Object.assign(run, { state: 'idle', scanned: result.records.length, lastScanAt: new Date(this.now()).toISOString(), error: result.errors ? `${result.errors} item${result.errors > 1 ? 's' : ''} could not be read (permissions).` : null });
    this.runFile.update(r => ({ ...r, [id]: { lastScanAt: run.lastScanAt } }));
    this.emit('filenex.location.scanned', { label: loc.label, files: result.records.length, changed: changed.length, removed: gone.length });
  }

  /** Hash only same-size candidates (exact duplicates), throttled, a bounded number per pass. */
  async hashPass() {
    if (this.hashing || this.settings().paused) return;
    this.hashing = true;
    try {
      const todo = hashCandidates(this.store.all()).filter(f => !f.hash).slice(0, MAX_HASH_PER_PASS);
      for (const f of todo) {
        if (this.settings().paused || !approvedLocationFor(f.path, this.settings())) continue;
        try { this.store.setHash(f.id, await hashFile(f.path), Date.parse(f.modifiedAt)); } catch { /* file changed or vanished */ }
        const pause = (await this.busy()) ? 200 : 10;
        await new Promise(r => setTimeout(r, pause));
      }
      if (todo.length) this.changed();
    } finally { this.hashing = false; }
  }

  /* ───────────── locations (the allowlist) ───────────── */

  status() {
    const s = this.settings();
    const locations: LocationStatus[] = s.locations.map(l => {
      const run = this.runs.get(l.id) ?? { state: 'idle' as const, scanned: 0, lastScanAt: null, error: null };
      const state: LocationStatus['state'] = s.paused || l.paused ? 'paused' : !existsSync(l.path) ? 'unavailable' : run.state;
      return { ...l, state, files: this.store.count(l.id), scanned: run.scanned, lastScanAt: run.lastScanAt, error: state === 'unavailable' ? 'Folder not found — it may have been moved, or a drive is disconnected.' : run.error };
    });
    const state = s.paused ? 'paused' : locations.some(l => l.state === 'scanning') ? 'scanning' : this.queue.length ? 'updating' : locations.some(l => l.state === 'error') ? 'error' : 'idle';
    return {
      state, paused: s.paused, locations, indexedFiles: this.store.count(), indexBytes: this.store.sizeBytes(),
      configured: s.locations.length > 0, lastScanAt: locations.map(l => l.lastScanAt).filter(Boolean).sort().pop() ?? null,
    };
  }

  addLocation(rawPath: unknown, opts: { confirmBroad?: boolean } = {}): IndexedLocation {
    const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
    let path: string;
    try { path = validateLocationPath(String(rawPath ?? ''), this.home, isDir); } catch (e) { throw new FilenexError('bad_request', (e as Error).message); }
    if (isBroadFolder(path, this.home) && !opts.confirmBroad) throw new FilenexError('conflict', `“${basename(path)}” is a broad folder. Prefer a specific work folder, or confirm to index all of it.`);
    const s = this.settings();
    const id = locationId(path);
    if (s.locations.some(l => l.id === id)) throw new FilenexError('conflict', 'This folder is already indexed.');
    const covering = s.locations.find(l => isInside(path, l.path));
    if (covering) throw new FilenexError('conflict', `Already covered by “${covering.label}” (${covering.path}).`);
    const loc: IndexedLocation = { id, path, label: basename(path) || path, paused: false, addedAt: new Date(this.now()).toISOString(), excludedFolders: [] };
    this.settingsFile.set({ ...s, locations: [...s.locations, loc] });
    this.runs.set(id, { state: 'idle', scanned: 0, lastScanAt: null, error: null });
    this.syncWatchers();
    this.enqueue(id);
    if (this.storage.settings().enabled) this.storage.enqueue(id);
    this.emit('filenex.location.added', { label: loc.label });
    return loc;
  }

  updateLocation(id: string, patch: { paused?: unknown; label?: unknown; excludedFolders?: unknown }) {
    const s = this.settings();
    const cur = s.locations.find(l => l.id === id);
    if (!cur) throw new FilenexError('not_found', 'This folder is not indexed.');
    const next: IndexedLocation = {
      ...cur,
      paused: typeof patch.paused === 'boolean' ? patch.paused : cur.paused,
      label: typeof patch.label === 'string' && patch.label.trim() ? patch.label.trim().slice(0, 80) : cur.label,
      excludedFolders: Array.isArray(patch.excludedFolders) ? patch.excludedFolders.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()).slice(0, 100) : cur.excludedFolders,
    };
    this.settingsFile.set({ ...s, locations: s.locations.map(l => (l.id === id ? next : l)) });
    this.syncWatchers();
    if (!next.paused && cur.paused) this.enqueue(id);
    return next;
  }

  /**
   * Stop indexing a folder — effective immediately (a running scan aborts and writes nothing).
   * Its records are kept or deleted only by the user's explicit choice. Real files are never touched.
   */
  removeLocation(id: string, deleteIndex: boolean) {
    const s = this.settings();
    const loc = s.locations.find(l => l.id === id);
    if (!loc) throw new FilenexError('not_found', 'This folder is not indexed.');
    const remaining = s.locations.filter(l => l.id !== id);
    this.settingsFile.set({ ...s, locations: remaining });
    this.queue.splice(0, this.queue.length, ...this.queue.filter(q => q !== id));
    this.watchers.get(id)?.close(); this.watchers.delete(id);
    this.runs.delete(id);
    this.storage.locationRemoved(id, deleteIndex);
    let removed = 0;
    if (deleteIndex) {
      const ids = this.store.all().filter(f => f.locationId === id && !approvedLocationFor(f.path, { locations: remaining }, { includePaused: true })).map(f => f.id);
      this.store.remove(ids);
      removed = ids.length;
      this.changed();
    }
    this.emit('filenex.location.removed', { label: loc.label, deletedIndex: deleteIndex });
    return { ok: true, deletedIndex: deleteIndex, recordsRemoved: removed };
  }

  pause() { this.settingsFile.set({ ...this.settings(), paused: true }); this.syncWatchers(); this.emit('filenex.indexing.paused', {}); return this.status(); }
  resume() {
    this.settingsFile.set({ ...this.settings(), paused: false });
    this.syncWatchers();
    void this.periodic();
    this.emit('filenex.indexing.resumed', {});
    return this.status();
  }

  updateSettings(patch: unknown) {
    const { locations: _l, ...rest } = (patch ?? {}) as Partial<FilenexSettings>;
    void _l; // folders are only changed through add/remove/update location
    const next = normalizeSettings({ ...this.settings(), ...rest, locations: this.settings().locations }, this.settings());
    this.settingsFile.set(next);
    this.syncWatchers();
    return next;
  }

  /** Rebuild: drop derived metadata and rescan approved folders. Permissions, settings and collections are kept. */
  rebuild() {
    this.store.clear(false);
    this.changed();
    for (const l of this.activeLocations()) { this.runs.set(l.id, { state: 'idle', scanned: 0, lastScanAt: null, error: null }); this.enqueue(l.id); }
    return { ok: true };
  }

  /** Clear: delete FileNEX's index (optionally collections). Real files are never touched. Folders stay approved. */
  clearIndex(includeCollections: boolean) {
    this.store.clear(includeCollections);
    this.changed();
    this.runFile.set({});
    for (const [id] of this.runs) this.runs.set(id, { state: 'idle', scanned: 0, lastScanAt: null, error: null });
    return { ok: true, clearedCollections: includeCollections };
  }

  /** Folder picker: names of sub-folders (no files, nothing indexed). */
  browse(rawPath?: string) {
    const path = rawPath && rawPath.trim() ? rawPath.trim().replace(/^~(?=$|[\\/])/, this.home) : this.home;
    let dirs: { name: string; path: string }[] = [];
    try {
      dirs = readdirSync(path, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !/\.(app|photoslibrary|musiclibrary)$/i.test(d.name) && d.name !== 'Library')
        .map(d => ({ name: d.name, path: join(path, d.name) })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
    } catch { throw new FilenexError('bad_request', 'That folder can’t be opened.'); }
    const indexed = this.settings().locations.map(l => l.path);
    return { path, parent: dirname(path) !== path ? dirname(path) : null, dirs: dirs.map(d => ({ ...d, indexed: indexed.some(p => isInside(d.path, p)) })), broad: isBroadFolder(path, this.home) };
  }

  /* ───────────── read models ───────────── */

  private async sources() {
    if (this.sourceCache && this.now() - this.sourceCache.at < 30_000) return this.sourceCache;
    const [contexts, projects] = await Promise.all([this.opts.sources.contexts().catch(() => []), this.opts.sources.projects().catch(() => [])]);
    this.sourceCache = { at: this.now(), contexts, projects };
    return this.sourceCache;
  }

  private derivedData() {
    if (!this.derived || this.derived.rev !== this.rev) {
      const all = this.store.all();
      this.derived = { rev: this.rev, versions: buildVersionGroups(all), duplicates: buildDuplicateGroups(all) };
    }
    return this.derived;
  }
  versionGroups() { return this.derivedData().versions; }
  duplicates() { return this.derivedData().duplicates; }

  async search(q: string, filters: SearchFilters = {}) {
    const src = await this.sources();
    const vIndex = versionIndex(this.versionGroups());
    const latest = new Map<string, 'latest' | 'older'>();
    for (const [fid, g] of vIndex) latest.set(fid, g.latestId === fid ? 'latest' : 'older');
    return search(this.store.all(), q, { contexts: src.contexts, projects: src.projects, latest, now: new Date(this.now()) }, filters);
  }

  file(id: string): FileRecord {
    const f = this.store.get(id);
    if (!f) throw new FilenexError('not_found', 'This file is not in the FileNEX index (it may have been removed, or its folder is no longer indexed).');
    return f;
  }

  async fileDetail(id: string) {
    const f = this.file(id);
    const src = await this.sources();
    const group = versionIndex(this.versionGroups()).get(id) ?? null;
    const dup = this.duplicates().find(g => g.files.some(x => x.id === id)) ?? null;
    return {
      file: f, exists: existsSync(f.path),
      contexts: contextsOf(f, src.contexts).map(c => ({ id: c.id, title: c.title, lastActiveAt: c.lastActiveAt })),
      project: projectOf(f, src.projects),
      versions: group, duplicate: dup,
      collections: this.store.collections().filter(c => c.fileIds.includes(id)).map(c => ({ id: c.id, name: c.name })),
      related: await this.related(id),
    };
  }

  async related(id: string): Promise<RelatedFile[]> {
    const f = this.file(id);
    const src = await this.sources();
    const group = versionIndex(this.versionGroups()).get(id);
    return relatedFiles(f, this.store.all(), { contexts: src.contexts, projects: src.projects, collections: this.store.collections(), versionIds: new Set(group?.files.map(x => x.id) ?? []) });
  }

  recentFiles(limit = 12) { return [...this.store.all()].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).slice(0, limit); }

  /** Files of one WorkNEX context: the files it saw (by path or name) + files changed in its project while it ran. */
  private filesForContext(c: WorkContextRef, all = this.store.all()): FileRecord[] {
    const direct = all.filter(f => c.files.some(x => (x.path ? x.path === f.path : x.name.toLowerCase() === f.name.toLowerCase())));
    const from = Date.parse(c.startedAt) - 3600_000, to = Date.parse(c.lastActiveAt) + 3600_000;
    const project = c.projectPath ? all.filter(f => isInside(f.path, c.projectPath!) && Date.parse(f.modifiedAt) >= from && Date.parse(f.modifiedAt) <= to) : [];
    return [...new Map([...direct, ...project].map(f => [f.id, f])).values()].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  }

  /** "Recent Work": recent WorkNEX contexts that have indexed files. Consumes WorkNEX — never re-tracks. */
  async recentWork(days = 7) {
    const src = await this.sources();
    const all = this.store.all();
    return src.contexts.filter(c => this.now() - Date.parse(c.lastActiveAt) <= days * 86_400_000)
      .map(c => ({ id: c.id, title: c.title, type: c.type, lastActiveAt: c.lastActiveAt, isActive: c.isActive, files: this.filesForContext(c, all) }))
      .filter(c => c.files.length).sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)).slice(0, 8);
  }

  /** All logical collections: WorkNEX contexts, DevNEX projects (only what is inside approved folders), and the user's own. */
  async collections() {
    const src = await this.sources();
    const all = this.store.all();
    const weekAgo = this.now() - 7 * 86_400_000;
    const projects = src.projects.map(p => {
      const files = all.filter(f => isInside(f.path, p.path));
      const covered = !!approvedLocationFor(p.path, this.settings(), { includePaused: true }) || this.settings().locations.some(l => isInside(l.path, p.path));
      return { id: `project:${p.id}`, name: p.name, path: p.path, files: files.length, recent: files.filter(f => Date.parse(f.modifiedAt) >= weekAgo).length, indexed: covered };
    });
    return {
      work: (await this.recentWork(30)).map(c => ({ id: `context:${c.id}`, name: c.title, type: c.type, files: c.files.length, lastActiveAt: c.lastActiveAt })),
      projects,
      user: this.store.collections().map(c => ({ id: `user:${c.id}`, name: c.name, files: c.fileIds.filter(fid => this.store.get(fid)).length, createdAt: c.createdAt })),
    };
  }

  /** One collection's files, with a type breakdown. */
  async collection(cid: string) {
    const src = await this.sources();
    const all = this.store.all();
    const [kind, id] = [cid.slice(0, cid.indexOf(':')), cid.slice(cid.indexOf(':') + 1)];
    let name = '', files: FileRecord[] = [], note: string | null = null;
    if (kind === 'context') {
      const c = src.contexts.find(x => x.id === id);
      if (!c) throw new FilenexError('not_found', 'This WorkNEX context is not available.');
      name = c.title; files = this.filesForContext(c, all);
    } else if (kind === 'project') {
      const p = src.projects.find(x => x.id === id);
      if (!p) throw new FilenexError('not_found', 'This DevNEX project is not available.');
      name = p.name; files = all.filter(f => isInside(f.path, p.path)).sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
      if (!files.length) note = 'This project’s folder is not inside an indexed location. Registering a project in DevNEX does not give FileNEX permission — add the folder in FileNEX › Settings if you want it indexed.';
    } else if (kind === 'user') {
      const c = this.store.collections().find(x => x.id === id);
      if (!c) throw new FilenexError('not_found', 'Collection not found.');
      name = c.name; files = c.fileIds.map(fid => this.store.get(fid)).filter((f): f is FileRecord => !!f);
    } else throw new FilenexError('bad_request', 'Unknown collection.');
    const byType: Record<string, number> = {};
    files.forEach(f => { byType[f.fileType] = (byType[f.fileType] ?? 0) + 1; });
    return { id: cid, kind, name, files: files.slice(0, 500), total: files.length, byType, note };
  }

  createCollection(name: unknown): Collection {
    const n = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    if (!n) throw new FilenexError('bad_request', 'Give the collection a name.');
    const id = randomUUID().slice(0, 12);
    this.store.createCollection(id, n);
    return this.store.collections().find(c => c.id === id)!;
  }
  deleteCollection(id: string) { this.store.deleteCollection(id); return { ok: true }; }
  addToCollection(id: string, fileId: string) {
    if (!this.store.collections().some(c => c.id === id)) throw new FilenexError('not_found', 'Collection not found.');
    this.file(fileId);
    this.store.addItem(id, fileId);
    return { ok: true };
  }
  removeFromCollection(id: string, fileId: string) { this.store.removeItem(id, fileId); return { ok: true }; }

  /* ───────────── safe actions (never delete/move/rename) ───────────── */

  private actionable(id: string) {
    const f = this.file(id);
    if (!approvedLocationFor(f.path, this.settings(), { includePaused: true })) throw new FilenexError('forbidden', 'This file’s folder is no longer indexed by FileNEX.');
    if (!existsSync(f.path)) throw new FilenexError('not_found', 'The file is no longer there — it may have been moved or deleted. The index updates on the next scan.');
    return f;
  }
  async open(id: string) { const f = this.actionable(id); await this.opts.platform.openPath(f.path).catch(e => { throw new FilenexError('unprocessable', (e as Error).message); }); return { ok: true }; }
  async reveal(id: string) { const f = this.actionable(id); await this.opts.platform.revealPath(f.path).catch(e => { throw new FilenexError('unprocessable', (e as Error).message); }); return { ok: true }; }
}

export type { SearchHit };
