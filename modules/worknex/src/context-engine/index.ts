import { createHash } from 'node:crypto';
import type { ActivityEvent, AppKind, ContextType, WorkContext } from '../types';
import { isDocumentFile } from '../activity-engine';

/**
 * Context engine: groups activity into Work Contexts with deterministic, explainable rules.
 * Conservative by design — when evidence is weak, a new context is created rather than merging unrelated work.
 */

export type ContextKey = { key: string; type: ContextType; title: string; confidence: number };

/** Same key reappearing within this window continues the same context; later, it becomes a new context. */
export const REUSE_WINDOW_MS: Record<ContextType, number> = {
  development: 4 * 3600_000, document: 2 * 3600_000, research: 30 * 60_000, meeting: 15 * 60_000, general: 30 * 60_000,
};

/** File-name tokens too generic to group documents by. */
const GENERIC = new Set(['untitled', 'document', 'documents', 'copy', 'final', 'draft', 'presentation', 'book', 'sheet', 'workbook', 'report', 'notes', 'note', 'new', 'test', 'temp', 'image', 'screenshot', 'scan', 'file', 'export', 'download', 'data', 'readme', 'index', 'main', 'meeting', 'minutes', 'slides', 'deck', 'version']);

/**
 * Family of a document from its leading token: "ISO29110_Executive_v6.pptx" and "ISO29110_Cost.xlsx" → ISO29110.
 * Needs ≥ 4 characters, a letter, and not a generic word or a date — otherwise null (no grouping).
 */
export function documentFamily(fileName: string): { key: string; label: string } | null {
  const stem = fileName.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const token = stem.split(/[_\-\s.()[\]]+/).find(Boolean) ?? '';
  if (token.length < 4 || !/[A-Za-z]/.test(token) || GENERIC.has(token.toLowerCase()) || /^\d{4}\d*$/.test(token) || /^v\d+$/i.test(token)) return null;
  return { key: token.toLowerCase(), label: token };
}

const meetingTitle = (e: ActivityEvent) =>
  e.appKind === 'meeting' && /chrome|safari|firefox|edge|brave|arc|vivaldi|opera/i.test(e.app) ? 'Google Meet' : /teams/i.test(e.app) ? 'Teams meeting' : /zoom/i.test(e.app) ? 'Zoom meeting' : `${e.app} meeting`;

/** The grouping key for one activity. Projects win; then meetings; then document families; then the app. */
export function keyFor(e: ActivityEvent): ContextKey {
  if (e.appKind === 'meeting') return { key: `meeting:${e.app.toLowerCase()}`, type: 'meeting', title: meetingTitle(e), confidence: 0.8 };
  if (e.projectId) return { key: `project:${e.projectId}`, type: 'development', title: e.projectName ?? 'Project', confidence: e.signals.includes('window-title') || e.signals.includes('file-path') ? 0.9 : 0.75 };
  if (e.fileName && (e.appKind === 'document' || isDocumentFile(e.fileName))) {
    const fam = documentFamily(e.fileName);
    return fam
      ? { key: `doc:${fam.key}`, type: 'document', title: fam.label, confidence: 0.7 }
      : { key: `docfile:${e.fileName.toLowerCase()}`, type: 'document', title: e.fileName.replace(/\.[A-Za-z0-9]{1,6}$/, ''), confidence: 0.6 };
  }
  if (e.appKind === 'browser') return { key: `browse:${(e.appKey ?? e.app).toLowerCase()}`, type: 'research', title: e.app, confidence: 0.4 };
  return { key: `app:${(e.appKey ?? e.app).toLowerCase()}`, type: e.appKind === 'editor' || e.appKind === 'terminal' ? 'development' : 'general', title: e.app, confidence: 0.4 };
}

export type ContextEvent = { type: 'worknex.context.started' | 'worknex.context.resumed' | 'worknex.context.ended'; context: WorkContext };

const ms = (iso: string) => new Date(iso).getTime();
export const spanMs = (c: Pick<WorkContext, 'spans'>) => c.spans.reduce((n, s) => n + Math.max(0, ms(s.end) - ms(s.start)), 0);
const newId = (key: string, at: string) => createHash('sha1').update(`${key}@${at}`).digest('hex').slice(0, 12);
const MAX_FILES = 12, MAX_URLS = 8, MAX_APPS = 8;

/**
 * Incremental context tracker. Feed it one observation per sample; it extends, switches or closes contexts.
 * State is a plain array (persisted by the store); `at` is explicit so behaviour is deterministic in tests.
 */
export class ContextTracker {
  current: { id: string; lastAt: number } | null = null;
  /** A meeting that keeps running while another app is in front (a call in progress). Its span stays open. */
  background: { id: string; since: number } | null = null;

  constructor(public contexts: WorkContext[], private readonly sampleMs: number) {
    // After a restart nothing is "active" until the next observation.
    for (const c of this.contexts) c.isActive = false;
  }

  get(id: string) { return this.contexts.find(c => c.id === id) ?? null; }
  active() { return this.current ? this.get(this.current.id) : null; }
  backgroundContext() { return this.background ? this.get(this.background.id) : null; }

  /** The meeting in front stays open in the background (the call goes on while you take notes elsewhere). */
  holdInBackground(at = new Date()): boolean {
    const cur = this.active();
    if (!cur || cur.type !== 'meeting') return false;
    this.extend(cur, at);
    this.background = { id: cur.id, since: at.getTime() };
    this.current = null;
    return true;
  }
  /** Keep the background meeting's span running up to `at`. */
  extendBackground(at = new Date()) { const c = this.backgroundContext(); if (c) this.extend(c, at); }
  /** Keep the current context running (e.g. idle while listening in a call). */
  extendCurrent(at = new Date()) {
    const c = this.active();
    if (!c) return;
    this.extend(c, at);
    this.current = { id: c.id, lastAt: at.getTime() };
  }
  /** The call ended (or can't be confirmed): close the background meeting. */
  endBackground(): ContextEvent[] {
    const c = this.backgroundContext();
    this.background = null;
    if (!c) return [];
    c.isActive = false;
    c.endedAt = c.lastActiveAt;
    return [{ type: 'worknex.context.ended', context: c }];
  }
  private extend(c: WorkContext, at: Date) {
    const iso = at.toISOString();
    if (c.spans.length) c.spans[c.spans.length - 1].end = iso;
    c.lastActiveAt = iso;
    const app = c.applications[0];
    if (app && this.current?.id === c.id) app.seconds += Math.min(at.getTime() - this.current.lastAt, this.sampleMs * 2) / 1000;
  }

  /** A meaningful observation of the front window. */
  observe(e: ActivityEvent, at = new Date(e.timestamp)): ContextEvent[] {
    const out: ContextEvent[] = [];
    const k = keyFor(e);
    const now = at.getTime(), iso = at.toISOString();
    const cur = this.active();
    // Samples further apart than a few intervals mean we were not watching (sleep, restart): don't bridge them.
    const continuous = !!this.current && now - this.current.lastAt <= this.sampleMs * 3;

    let target: WorkContext;
    if (cur && cur.key === k.key && continuous) {
      target = cur;
      this.touch(cur, e, now - this.current!.lastAt, iso);
      cur.spans[cur.spans.length - 1].end = iso;
    } else {
      if (cur) out.push(...this.close(cur, { at: new Date(this.current!.lastAt).toISOString(), by: e.app, kind: e.appKind }));
      const bg = this.backgroundContext();
      if (bg && bg.key === k.key) {
        // Back to the meeting that kept running in the background: same stretch, no new span.
        this.background = null;
        target = bg;
        this.touch(target, e, this.sampleMs, iso);
        target.spans[target.spans.length - 1].end = iso;
        this.current = { id: target.id, lastAt: now };
        return out;
      }
      const reuse = [...this.contexts].reverse().find(c => c.key === k.key && now - ms(c.lastActiveAt) <= REUSE_WINDOW_MS[k.type]);
      if (reuse) {
        target = reuse;
        target.spans.push({ start: iso, end: iso });
        target.endedAt = undefined;
        out.push({ type: 'worknex.context.resumed', context: target });
      } else {
        target = {
          id: newId(k.key, iso), key: k.key, title: k.title, type: k.type, startedAt: iso, lastActiveAt: iso,
          spans: [{ start: iso, end: iso }], applications: [], files: [], urls: [],
          projectId: e.projectId, projectPath: e.projectPath, confidence: k.confidence, isActive: true, isSaved: false,
          sourceSignals: [], interruptions: [],
        };
        this.contexts.push(target);
        out.push({ type: 'worknex.context.started', context: target });
      }
      target.isActive = true;
      this.touch(target, e, this.sampleMs, iso);
    }
    this.current = { id: target.id, lastAt: now };
    return out;
  }

  /**
   * The current context stops here. `untracked` (an app not on the allowlist is in front) and `paused` record
   * nothing at all — the timeline simply shows a gap. Only `idle` (from a tracked app) is explained.
   */
  pause(reason: 'idle' | 'untracked' | 'paused', at = new Date()): ContextEvent[] {
    const cur = this.active();
    if (!cur) return [];
    void at;
    const lastAt = new Date(this.current!.lastAt).toISOString();
    return this.close(cur, reason === 'idle' ? { at: lastAt, by: 'You stepped away', kind: 'idle' } : null);
  }

  private close(c: WorkContext, interruption: { at: string; by: string; kind: AppKind | 'idle' } | null): ContextEvent[] {
    c.isActive = false;
    c.endedAt = c.lastActiveAt;
    if (interruption && interruption.by !== c.applications[0]?.name) {
      c.interruptions = [...c.interruptions, interruption].slice(-10);
    }
    this.current = null;
    return [{ type: 'worknex.context.ended', context: c }];
  }

  /** Fold one observation's metadata into a context (bounded lists — never unbounded growth). */
  private touch(c: WorkContext, e: ActivityEvent, elapsedMs: number, iso: string) {
    c.lastActiveAt = iso;
    const seconds = Math.min(elapsedMs, this.sampleMs * 2) / 1000;
    const app = c.applications.find(a => a.name === e.app);
    if (app) app.seconds += seconds;
    else c.applications.push({ name: e.app, key: e.appKey, bundleId: e.appKey && !/[\\/]/.test(e.appKey) ? e.appKey : null, path: e.appKey && /[\\/]/.test(e.appKey) ? e.appKey : null, seconds, kind: e.appKind });
    c.applications.sort((a, b) => b.seconds - a.seconds);
    c.applications = c.applications.slice(0, MAX_APPS);
    if (e.fileName) {
      c.files = [{ name: e.fileName, path: e.filePath ?? null, lastSeenAt: iso, appKey: e.appKey }, ...c.files.filter(f => f.name !== e.fileName)].slice(0, MAX_FILES);
    }
    if (e.url) c.urls = [{ url: e.url, title: e.windowTitle ?? null, lastSeenAt: iso, appKey: e.appKey }, ...c.urls.filter(u => u.url !== e.url)].slice(0, MAX_URLS);
    if (e.windowTitle) { c.lastTitle = e.windowTitle.slice(0, 200); c.lastTitleAppKey = e.appKey; }
    if (!c.projectId && e.projectId && c.key === `project:${e.projectId}`) { c.projectId = e.projectId; c.projectPath = e.projectPath; }
    c.sourceSignals = [...new Set([...c.sourceSignals, ...e.signals])].slice(0, 12);
    if (c.type === 'research' && e.windowTitle) c.subtitle = e.windowTitle.slice(0, 120);
    if (c.type === 'document' && e.fileName && c.key.startsWith('doc:')) c.subtitle = e.fileName;
  }
}

/** Meaningful = worth showing in Recent / Where was I (not a 20-second glance at an app). */
export const isMeaningful = (c: WorkContext, minMs = 3 * 60_000) =>
  c.isSaved || (spanMs(c) >= minMs && c.type !== 'general') || spanMs(c) >= 10 * 60_000;
