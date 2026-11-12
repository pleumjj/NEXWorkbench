import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFile } from '@nex/config';
import type { ForegroundWindow } from '@nex/shared';
import type { PlatformAdapter } from '@nex/platform-core';
import { descendantsOf, groupProcesses } from '@nex/process-core';
import type { ActivityEvent, AvailableApplication, Insights, KnownProject, ProjectDirectory, ResumePlan, ResumeResult, SavedContext, TimelineEntry, TrackedApplication, TrackingLevel, WhereWasI, WorkContext, WorknexSettings, WorknexStatus } from './types';
import { WorknexError } from './errors';
import { DEFAULT_SETTINGS, defaultLevel, isExcludedPath, isSensitiveApp, needsTitle, normalizeSettings, permissionsFor, sanitizeActivity, titleMentionsExcluded, trackedAppId } from './privacy-engine';
import { appKindOf, normalizeActivity } from './activity-engine';
import { ContextTracker, isMeaningful, keyFor, spanMs, type ContextEvent } from './context-engine';
import { DEFAULT_SESSION_OPTIONS, applyRetention, buildInsights, buildSessions, buildTimeline, buildTimesheet, dayOf, dayRange, timesheetCsv, whereWasI, type TimesheetDay } from './session-engine';
import { buildResumePlan, executeResume, toSaved } from './resume-engine';

export type WorknexEngineOptions = {
  platform: PlatformAdapter;
  dataDir: string;
  /** DevNEX's knowledge of projects (wired by the Workbench) — WorkNEX never rediscovers projects itself. */
  directory: ProjectDirectory;
  /** Local event sink (Workbench EventBus). Only derived events are emitted — never per-sample activity. */
  emit?: (type: string, data: unknown) => void;
  /** Approximate RAM of a context's apps + project processes (shared process core). */
  resourceUsage?: (c: WorkContext) => Promise<number | null>;
  /** Foreground sampling interval. */
  sampleMs?: number;
  /** NEX Workbench root (its own processes are never offered as trackable apps). */
  workspaceRoot?: string;
  now?: () => number;
};

type History = { version: 1; contexts: WorkContext[] };
const RAW_BUFFER = 720; // ~1 h of samples at 5 s, memory only
/** A meeting app using at least this much CPU (% of one core) is treated as "in a call" (audio/video processing). */
export const CALL_CPU_THRESHOLD = 5;
/** Safety cap: a background meeting longer than this without returning to the meeting app ends. */
const MAX_BACKGROUND_MEETING_MS = 4 * 3600_000;
const FLUSH_MS = 60_000;

/** WorkNEX business logic behind one facade. The API layer only routes HTTP here. */
export class WorknexEngine {
  private readonly settingsFile: JsonFile<WorknexSettings>;
  private readonly historyFile: JsonFile<History>;
  private readonly savedFile: JsonFile<{ version: 1; saved: SavedContext[] }>;
  readonly tracker: ContextTracker;
  private raw: ActivityEvent[] = [];
  private timers: NodeJS.Timeout[] = [];
  private dirty = false;
  private ticking = false;
  private lastSampleAt: string | null = null;
  private lastTitleStatus: ForegroundWindow['titleStatus'] = 'off';
  private detectionError: string | null = null;
  private cache = new Map<string, { at: number; value: unknown }>();
  private branchCheckedAt = new Map<string, number>();
  /** The tracked meeting app whose call may continue in the background. */
  private meetingApp: TrackedApplication | null = null;
  readonly sampleMs: number;

  constructor(private readonly opts: WorknexEngineOptions) {
    this.sampleMs = opts.sampleMs ?? (opts.platform.id === 'win32' ? 10_000 : 5_000);
    this.settingsFile = new JsonFile(join(opts.dataDir, 'settings.json'), () => ({ ...DEFAULT_SETTINGS }), raw => normalizeSettings(raw));
    this.historyFile = new JsonFile(join(opts.dataDir, 'history.json'), () => ({ version: 1, contexts: [] }), (raw: any) => ({ version: 1, contexts: Array.isArray(raw?.contexts) ? raw.contexts : [] }));
    this.savedFile = new JsonFile(join(opts.dataDir, 'saved.json'), () => ({ version: 1, saved: [] }), (raw: any) => ({ version: 1, saved: Array.isArray(raw?.saved) ? raw.saved : [] }));
    const contexts = applyRetention(this.historyFile.get().contexts, this.settings().retentionDays, this.now());
    this.tracker = new ContextTracker(contexts, this.sampleMs);
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  private emit(type: string, data: unknown) { try { this.opts.emit?.(type, data); } catch { /* never let a listener break collection */ } }
  settings() { return this.settingsFile.get(); }

  /* ───────────── lifecycle ───────────── */

  start() {
    if (this.timers.length) return;
    const tick = () => { void this.tick(); };
    this.timers.push(setInterval(tick, this.sampleMs), setInterval(() => this.flush(), FLUSH_MS), setInterval(() => this.retain(), 3600_000));
    this.timers.forEach(t => t.unref());
    tick();
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; this.tracker.pause('paused'); this.flush(true); }

  /** Write derived history at most once a minute (or immediately on explicit actions). */
  flush(force = false) {
    if (!this.dirty && !force) return;
    this.historyFile.set({ version: 1, contexts: this.tracker.contexts });
    this.dirty = false;
  }
  private retain() {
    this.tracker.contexts = applyRetention(this.tracker.contexts, this.settings().retentionDays, this.now());
    const cutoff = this.now() - 3600_000;
    this.raw = this.raw.filter(e => new Date(e.timestamp).getTime() >= cutoff);
    this.dirty = true;
  }

  /** Small TTL cache so expensive lookups (process tree, open files, DevNEX projects) never run every sample. */
  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: this.now(), value });
    if (this.cache.size > 200) this.cache.clear();
    return value;
  }

  private projects(): Promise<KnownProject[]> {
    return this.cached('projects', 30_000, () => this.opts.directory.projects().catch(() => []));
  }

  /**
   * Is the tracked meeting app in a call? Evidence: its processes keep using CPU (audio/video), which an idle,
   * merely-open meeting app does not. Only for tracked meeting apps; cached per sample.
   */
  private async callActive(): Promise<boolean> {
    const app = this.meetingApp;
    if (!app || app.kind !== 'meeting' || !this.settings().trackedApplications.some(a => a.id === app.id && a.enabled)) return false;
    return this.cached(`call:${app.id}`, Math.max(1000, this.sampleMs - 500), async () => {
      const all = await this.opts.platform.listProcesses();
      const groups = groupProcesses(all, { selfRoot: this.opts.workspaceRoot ?? '', selfPid: process.pid, systemName: 'system' });
      const exe = app.executable?.toLowerCase();
      const g = groups.find(x => x.kind === 'app' && ((exe && x.path?.toLowerCase() === exe) || x.name.toLowerCase() === app.displayName.toLowerCase()));
      if (!g) return false;
      return (await this.opts.platform.appCpuPercent(g.pids).catch(() => 0)) >= CALL_CPU_THRESHOLD;
    });
  }

  /** Working directories of the front app's own child processes (editor/terminal shells): no permission needed. */
  private async childDirs(pid: number): Promise<string[]> {
    return this.cached(`dirs:${pid}`, 60_000, async () => {
      const all = await this.opts.platform.listProcesses();
      const kids = [...descendantsOf(all, pid)].slice(0, 40);
      const cwds = await this.opts.platform.processCwds(kids);
      return [...new Set([...cwds.values()].filter(d => d && d !== '/'))];
    });
  }

  /**
   * One sample. Ingestion boundary first:
   *   1. identify the front app (no title requested);
   *   2. not on the allowlist → drop it here: nothing is kept, grouped, emitted or logged — the reading goes out of scope;
   *   3. allowed → ask the OS only for what this app's permission level grants (title, folders, open files, URL).
   */
  async tick(at = new Date(this.now())): Promise<ContextEvent[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const s = this.settings();
      if (s.paused || !s.trackedApplications.some(a => a.enabled)) return this.apply([...this.tracker.endBackground(), ...this.tracker.pause('paused', at)]);
      const idleAfter = s.idleMinutes * 60_000;
      const pre: ContextEvent[] = [];
      // A meeting running in the background: keep counting while the call is still active.
      if (this.tracker.background) {
        const tooLong = at.getTime() - this.tracker.background.since > MAX_BACKGROUND_MEETING_MS;
        if (!tooLong && await this.callActive()) this.tracker.extendBackground(at);
        else { pre.push(...this.tracker.endBackground()); this.meetingApp = null; }
      }
      // Leaving the meeting in front: if the call goes on, it moves to the background instead of ending.
      const leaveMeeting = async (): Promise<boolean> => this.tracker.active()?.type === 'meeting' && await this.callActive() && this.tracker.holdInBackground(at);

      let first: ForegroundWindow;
      try { first = await this.opts.platform.foregroundWindow({ title: false }); this.detectionError = null; }
      catch (e) { this.detectionError = (e as Error).message; return this.apply(pre); }
      this.lastSampleAt = at.toISOString();

      let clean = sanitizeActivity(first, s, idleAfter);
      if (!clean) return this.apply([...pre, ...(await leaveMeeting() ? [] : this.tracker.pause('untracked', at))]);
      if (clean.kind === 'idle') {
        // Listening in a call is not "away": a meeting in front with an active call keeps running while idle.
        if (this.tracker.active()?.type === 'meeting' && await this.callActive()) { this.tracker.extendCurrent(at); return this.apply(pre); }
        return this.apply([...pre, ...this.tracker.pause('idle', at)]);
      }
      if (needsTitle(clean.app)) {
        const withTitle = await this.opts.platform.foregroundWindow({ title: true }).catch(() => null);
        // Only use the second reading if the same allowed app is still in front; otherwise this sample is dropped.
        const again = withTitle && withTitle.pid === first.pid ? sanitizeActivity(withTitle, s, idleAfter) : null;
        if (!again || again.kind !== 'app' || again.app.id !== clean.app.id) return this.apply([...pre, ...(await leaveMeeting() ? [] : this.tracker.pause('untracked', at))]);
        clean = again;
        this.lastTitleStatus = withTitle!.titleStatus;
      }

      const { fw: w, app } = clean;
      const perms = app.permissions;
      const kind = app.kind;
      const projects = await this.projects();
      // Level 2+ (context): project/folder metadata from the app's own terminals. Level 3: open documents. URL: separate opt-in.
      const dirs = w.pid && perms.windowTitle && (kind === 'editor' || kind === 'terminal') ? await this.childDirs(w.pid).catch(() => []) : [];
      const openDocs = w.pid && perms.fileMetadata && kind === 'document' ? await this.cached(`docs:${w.pid}`, 30_000, () => this.opts.platform.openDocuments(w.pid!)).catch(() => []) : [];
      const url = perms.url && kind === 'browser' ? await this.opts.platform.browserUrl(w).catch(() => null) : null;
      const e = this.scrubPaths(normalizeActivity({ ...w, key: app.applicationId }, {
        at, projects, dirs, openDocs: openDocs.filter(d => !isExcludedPath(d, s.excludedPaths)), url, trackFiles: perms.fileMetadata, kind,
      }), s);
      this.raw.push(e);
      if (this.raw.length > RAW_BUFFER) this.raw.splice(0, this.raw.length - RAW_BUFFER);
      const cur = this.tracker.active();
      if (cur?.type === 'meeting' && cur.key !== keyFor(e).key) await leaveMeeting();
      const events = [...pre, ...this.tracker.observe(e, at)];
      const active = this.tracker.active();
      // Remember which tracked meeting app is in a call (only real meeting apps — a browser tab's CPU says nothing).
      if (active?.type === 'meeting' && app.kind === 'meeting') this.meetingApp = app;
      if (active?.projectPath) void this.refreshBranch(active);
      return this.apply(events);
    } finally { this.ticking = false; }
  }

  /** Excluded folders never reach a context: their file paths, projects and titles are dropped. */
  private scrubPaths(e: ActivityEvent, s: WorknexSettings): ActivityEvent {
    if (!s.excludedPaths.length) return e;
    const out = { ...e };
    if (isExcludedPath(out.filePath, s.excludedPaths)) { out.filePath = undefined; out.fileName = undefined; }
    if (isExcludedPath(out.projectPath, s.excludedPaths)) { out.projectPath = undefined; out.projectId = undefined; out.projectName = undefined; }
    if (out.windowTitle && titleMentionsExcluded(out.windowTitle, s.excludedPaths)) { out.windowTitle = undefined; out.fileName = out.filePath ? out.fileName : undefined; }
    return out;
  }

  private async refreshBranch(c: WorkContext) {
    const last = this.branchCheckedAt.get(c.id) ?? 0;
    if (this.now() - last < 10 * 60_000) return;
    this.branchCheckedAt.set(c.id, this.now());
    const branch = await this.opts.directory.gitBranch(c.projectPath!).catch(() => null);
    if (branch && branch !== c.gitBranch) { c.gitBranch = branch; this.dirty = true; }
  }

  private apply(events: ContextEvent[]) {
    if (events.length || this.tracker.active()) this.dirty = true;
    for (const ev of events) {
      // Only meaningful derived events leave the engine; short glances stay silent.
      if (ev.type === 'worknex.context.ended' && !isMeaningful(ev.context)) continue;
      if (ev.type !== 'worknex.context.ended' && ev.context.type === 'general') continue;
      this.emit(ev.type, { id: ev.context.id, title: ev.context.title, type: ev.context.type });
    }
    return events;
  }

  /* ───────────── read models ───────────── */

  private savedList() { return this.savedFile.get().saved; }
  private markSaved() {
    const ids = new Set(this.savedList().map(s => s.contextId));
    for (const c of this.tracker.contexts) c.isSaved = ids.has(c.id);
  }

  status(): WorknexStatus {
    const s = this.settings();
    const active = this.tracker.active();
    const today = dayOf(this.now());
    const apps = s.trackedApplications.filter(a => a.enabled);
    const detection = this.detectionError ? 'unavailable' : (apps.some(a => needsTitle(a)) && this.lastTitleStatus === 'needs-permission') ? 'limited' : 'full';
    return {
      collecting: !s.paused && !!this.timers.length && apps.length > 0, paused: s.paused, detection,
      trackedApps: apps.length, detailedApps: apps.filter(a => a.level >= 2).length, urlApps: apps.filter(a => a.permissions.url).length,
      detectionDetail: this.detectionError
        ?? (detection === 'limited' ? (this.opts.platform.id === 'darwin'
          ? 'Some tracked apps are allowed window titles, but macOS needs Accessibility permission for the app running NEX (System Settings › Privacy & Security › Accessibility). Until then WorkNEX records those apps at presence level.'
          : 'Window titles are unavailable.') : null),
      activeContext: active ? { id: active.id, title: active.title, type: active.type, since: active.spans[active.spans.length - 1].start } : null,
      todayContexts: this.tracker.contexts.filter(c => dayOf(c.lastActiveAt) === today && isMeaningful(c)).length,
      savedContexts: this.savedList().length,
      lastSampleAt: this.lastSampleAt,
    };
  }

  /** Recent meaningful contexts, newest first. */
  recent(limit = 12): WorkContext[] {
    this.markSaved();
    return [...this.tracker.contexts].filter(c => isMeaningful(c) || c.isActive).sort((a, b) => +new Date(b.lastActiveAt) - +new Date(a.lastActiveAt)).slice(0, limit);
  }

  context(id: string): WorkContext {
    this.markSaved();
    const c = this.tracker.get(id);
    if (!c) throw new WorknexError('not_found', 'This work context is no longer in your history (it may have passed the retention period or been cleared).');
    return c;
  }

  /** Context detail enriched with live DevNEX + shared process data (not stored). */
  async contextDetail(id: string) {
    const c = this.context(id);
    const project = c.projectId ? (await this.projects()).find(p => p.id === c.projectId) ?? null : null;
    const memoryBytes = await this.opts.resourceUsage?.(c).catch(() => null) ?? null;
    return { context: c, durationMs: spanMs(c), project, memoryBytes, saved: this.savedList().filter(s => s.contextId === c.id) };
  }

  timeline(day = dayOf(this.now())): { day: string; entries: TimelineEntry[]; sessions: ReturnType<typeof buildSessions>; days: string[] } {
    const opts = { ...DEFAULT_SESSION_OPTIONS, idleGapMs: this.settings().idleMinutes * 60_000 };
    const days = [...new Set(this.tracker.contexts.flatMap(c => c.spans.map(s => dayOf(s.start))))].sort().reverse();
    return { day, entries: buildTimeline(this.tracker.contexts, day, opts), sessions: buildSessions(this.tracker.contexts, day, opts), days };
  }

  /** Your own daily summary: minutes per work item per day (tracked apps only), with half-hour rounding for timesheets. */
  timesheet(from = dayOf(this.now()), to = from): TimesheetDay[] {
    if (to < from) throw new WorknexError('bad_request', '"to" must be on or after "from".');
    return buildTimesheet(this.tracker.contexts, dayRange(from, to), this.now());
  }
  timesheetCsv(from?: string, to?: string) { return timesheetCsv(this.timesheet(from, to)); }

  insights(day = dayOf(this.now())): Insights { return buildInsights(this.tracker.contexts, day); }

  async where(): Promise<WhereWasI & object | null> {
    const w = whereWasI(this.tracker.contexts);
    if (!w) return null;
    const project = w.context.projectId ? (await this.projects()).find(p => p.id === w.context.projectId) : undefined;
    const services = project?.services.filter(s => s.running && s.port).map(s => `localhost:${s.port}`) ?? [];
    return { ...w, related: [...new Set([...services, ...w.related])].slice(0, 4) };
  }

  saved(): SavedContext[] { return [...this.savedList()].sort((a, b) => +new Date(b.savedAt) - +new Date(a.savedAt)); }

  /* ───────────── actions (all explicit) ───────────── */

  async save(contextId: string, input: { label?: string; note?: string }) {
    const c = contextId === 'current' ? (this.tracker.active() ?? this.recent(1)[0]) : this.context(contextId);
    if (!c) throw new WorknexError('conflict', 'There is no work context to save yet. WorkNEX needs a few seconds of activity first.');
    const project = c.projectId ? (await this.projects()).find(p => p.id === c.projectId) ?? null : null;
    const saved = toSaved(c, { id: randomUUID(), label: input.label, note: input.note, project, at: new Date(this.now()) });
    this.savedFile.set({ version: 1, saved: [saved, ...this.savedList()].slice(0, 200) });
    c.isSaved = true;
    this.flush(true);
    this.emit('worknex.context.saved', { id: saved.id, title: saved.label });
    return saved;
  }

  deleteSaved(id: string) {
    const list = this.savedList();
    if (!list.some(s => s.id === id)) throw new WorknexError('not_found', 'Saved context not found.');
    this.savedFile.set({ version: 1, saved: list.filter(s => s.id !== id) });
    this.markSaved();
    return { ok: true };
  }

  private async source(kind: 'context' | 'saved', id: string) {
    if (kind === 'saved') {
      const s = this.savedList().find(x => x.id === id);
      if (!s) throw new WorknexError('not_found', 'Saved context not found.');
      return { ...s, kind: 'saved' as const };
    }
    return { ...this.context(id), kind: 'context' as const };
  }

  private async plan(kind: 'context' | 'saved', id: string) {
    const src = await this.source(kind, id);
    const project = src.projectId ? (await this.projects()).find(p => p.id === src.projectId) ?? null : null;
    return buildResumePlan(src, { project, settings: this.settings(), exists: existsSync });
  }

  async resumePreview(kind: 'context' | 'saved', id: string): Promise<ResumePlan & { confirmBeforeOpen: boolean }> {
    const { plan } = await this.plan(kind, id);
    return { ...plan, confirmBeforeOpen: this.settings().confirmBeforeOpen };
  }

  async resume(kind: 'context' | 'saved', id: string, itemIds: string[]): Promise<ResumeResult> {
    const { plan, internal } = await this.plan(kind, id);
    const unknown = itemIds.filter(i => !internal.some(x => x.id === i));
    if (unknown.length) throw new WorknexError('bad_request', 'Some resume items are out of date. Open the preview again.');
    if (!itemIds.length) throw new WorknexError('bad_request', 'Select at least one item to reopen.');
    const result = await executeResume(internal, itemIds, this.opts.platform);
    if (kind === 'saved') {
      this.savedFile.update(f => ({ ...f, saved: f.saved.map(s => (s.id === id ? { ...s, lastResumedAt: new Date(this.now()).toISOString() } : s)) }));
    }
    this.emit('worknex.context.resumed', { id, title: plan.title, opened: result.opened.length });
    return result;
  }

  /** General settings. The allowlist is NOT editable here — consent only goes through add/update/remove tracked app. */
  updateSettings(patch: unknown) {
    const { trackedApplications: _ignored, ...rest } = (patch ?? {}) as Partial<WorknexSettings>;
    void _ignored;
    const next = normalizeSettings({ ...this.settings(), ...rest, trackedApplications: this.settings().trackedApplications }, this.settings());
    const wasPaused = this.settings().paused;
    this.settingsFile.set(next);
    if (wasPaused !== next.paused) this.emit(next.paused ? 'worknex.collection.paused' : 'worknex.collection.resumed', {});
    if (next.paused) this.apply(this.tracker.pause('paused'));
    this.cache.clear();
    this.retain();
    return next;
  }
  pause() { return this.updateSettings({ paused: true }); }
  resumeTracking() { return this.updateSettings({ paused: false }); }

  /* ───────────── tracked applications (the allowlist) ───────────── */

  trackedApps(): TrackedApplication[] { return this.settings().trackedApplications; }
  trackedApp(id: string): TrackedApplication {
    const a = this.trackedApps().find(x => x.id === id);
    if (!a) throw new WorknexError('not_found', 'This application is not tracked.');
    return a;
  }

  /** Explicit consent for one app. Starts at the conservative default level (presence only unless the user changed the defaults). */
  addTrackedApp(input: { applicationId?: unknown; displayName?: unknown; bundleId?: unknown; executable?: unknown }): TrackedApplication {
    const applicationId = typeof input.applicationId === 'string' ? input.applicationId.trim() : '';
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!applicationId || !displayName || applicationId.length > 500 || displayName.length > 120) throw new WorknexError('bad_request', 'Choose an application to track.');
    const s = this.settings();
    if (s.trackedApplications.some(a => a.applicationId.toLowerCase() === applicationId.toLowerCase())) throw new WorknexError('conflict', `${displayName} is already tracked.`);
    const bundleId = typeof input.bundleId === 'string' && input.bundleId ? input.bundleId : undefined;
    const executable = typeof input.executable === 'string' && input.executable ? input.executable : undefined;
    const kind = appKindOf({ appName: displayName, bundleId: bundleId ?? null, path: executable ?? null });
    const level = defaultLevel(s);
    const app: TrackedApplication = {
      id: trackedAppId(applicationId), applicationId, displayName, bundleId, executable, kind, enabled: true, level,
      permissions: permissionsFor(level, kind, s.trackUrlsByDefault), addedAt: new Date(this.now()).toISOString(),
    };
    this.settingsFile.set({ ...s, trackedApplications: [...s.trackedApplications, app] });
    this.cache.delete('available');
    this.emit('worknex.app.tracked', { name: app.displayName });
    return app;
  }

  /** Change an app's level / URL permission / enabled flag. Lowering takes effect on the next sample. */
  updateTrackedApp(id: string, patch: { level?: unknown; url?: unknown; enabled?: unknown }): TrackedApplication {
    const s = this.settings();
    const cur = this.trackedApp(id);
    const level: TrackingLevel = patch.level === 1 || patch.level === 2 || patch.level === 3 ? patch.level : cur.level;
    const url = typeof patch.url === 'boolean' ? patch.url : cur.permissions.url;
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled;
    const next: TrackedApplication = { ...cur, level, enabled, permissions: permissionsFor(level, cur.kind, url) };
    this.settingsFile.set({ ...s, trackedApplications: s.trackedApplications.map(a => (a.id === id ? next : a)) });
    if (!enabled) { this.apply([...this.tracker.endBackground(), ...this.tracker.pause('untracked')]); if (this.meetingApp?.id === id) this.meetingApp = null; }
    return next;
  }

  /**
   * Stop tracking an app — effective immediately. History is kept or deleted only by the user's explicit choice:
   * deleting removes the app and everything it contributed (files, URLs, titles) from WorkNEX history and save points.
   * Contexts left with no tracked app are deleted. Files, app data, browser history, DevNEX and MemNEX are untouched.
   */
  removeTrackedApp(id: string, deleteHistory: boolean) {
    const s = this.settings();
    const app = this.trackedApp(id);
    this.settingsFile.set({ ...s, trackedApplications: s.trackedApplications.filter(a => a.id !== id) });
    this.apply([...this.tracker.endBackground(), ...this.tracker.pause('untracked')]);
    if (this.meetingApp?.id === id) this.meetingApp = null;
    this.cache.delete('available');
    let contextsRemoved = 0;
    if (deleteHistory) {
      const keys = new Set([app.applicationId, app.bundleId, app.executable].filter((x): x is string => !!x).map(x => x.toLowerCase()));
      const mine = (k: string | null | undefined) => !!k && keys.has(k.toLowerCase());
      const before = this.tracker.contexts.length;
      this.tracker.contexts = this.tracker.contexts.map(c => ({
        ...c,
        applications: c.applications.filter(a => !mine(a.key) && !mine(a.bundleId) && !mine(a.path)),
        files: c.files.filter(f => !mine(f.appKey)), urls: c.urls.filter(u => !mine(u.appKey)),
        lastTitle: mine(c.lastTitleAppKey) ? undefined : c.lastTitle, lastTitleAppKey: mine(c.lastTitleAppKey) ? undefined : c.lastTitleAppKey,
        subtitle: mine(c.lastTitleAppKey) ? undefined : c.subtitle,
      })).filter(c => c.applications.length > 0);
      contextsRemoved = before - this.tracker.contexts.length;
      this.raw = this.raw.filter(e => !mine(e.appKey));
      this.savedFile.update(f => ({
        ...f, saved: f.saved.map(x => ({ ...x, applications: x.applications.filter(a => !mine(a.key) && !mine(a.bundleId) && !mine(a.path)), files: x.files.filter(fl => !mine((fl as { appKey?: string | null }).appKey)), urls: x.urls.filter(u => !mine((u as { appKey?: string | null }).appKey)) }))
          .filter(x => x.applications.length > 0),
      }));
      this.flush(true);
    }
    this.emit('worknex.app.untracked', { name: app.displayName, deletedHistory: deleteHistory });
    return { ok: true, deletedHistory: deleteHistory, contextsRemoved };
  }

  /**
   * Apps the user could choose from: running GUI apps (+ installed apps where the OS lists them).
   * Discovery is not consent — nothing is added, and listing writes nothing to WorkNEX history.
   */
  async availableApps(): Promise<AvailableApplication[]> {
    const list = await this.cached('available', 30_000, async () => {
      const raw = await this.opts.platform.listProcesses();
      const groups = groupProcesses(raw, { selfRoot: this.opts.workspaceRoot ?? '', selfPid: process.pid, systemName: 'system' }).filter(g => g.kind === 'app' && g.path);
      const running = await Promise.all(groups.map(async g => {
        const bundleId = this.opts.platform.id === 'darwin' ? await this.opts.platform.bundleId(g.path!) : null;
        return { name: g.name, path: g.path!, bundleId, running: true };
      }));
      const installed = await this.cached('installed', 10 * 60_000, () => this.opts.platform.installedApplications().catch(() => []));
      const byId = new Map<string, { name: string; path: string; bundleId: string | null; running: boolean }>();
      for (const a of [...running, ...installed.map(i => ({ ...i, running: false }))]) {
        const id = (a.bundleId ?? a.path.toLowerCase());
        if (!byId.has(id)) byId.set(id, a);
      }
      return [...byId.entries()].map(([applicationId, a]) => ({ applicationId, displayName: a.name, bundleId: a.bundleId ?? undefined, executable: a.path, running: a.running }));
    });
    const tracked = new Set(this.trackedApps().map(a => a.applicationId.toLowerCase()));
    return list.map(a => ({
      ...a, kind: appKindOf({ appName: a.displayName, bundleId: a.bundleId ?? null, path: a.executable ?? null }),
      tracked: tracked.has(a.applicationId.toLowerCase()), sensitive: isSensitiveApp(a.displayName, a.bundleId ?? ''),
    })).sort((x, y) => Number(y.running) - Number(x.running) || x.displayName.localeCompare(y.displayName));
  }

  /** Deletes WorkNEX history only (contexts, in-memory activity, optionally save points). Nothing else is touched. */
  clearHistory(includeSaved: boolean) {
    this.tracker.contexts = [];
    this.tracker.current = null;
    this.tracker.background = null;
    this.meetingApp = null;
    this.raw = [];
    this.cache.clear();
    this.historyFile.set({ version: 1, contexts: [] });
    if (includeSaved) this.savedFile.set({ version: 1, saved: [] });
    this.dirty = false;
    return { ok: true, clearedSaved: includeSaved };
  }

  /** In-memory raw activity count (shown in Settings so users can see how little is kept). */
  rawCount() { return this.raw.length; }
}

export const stableId = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
