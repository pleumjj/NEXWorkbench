import { createHash } from 'node:crypto';
import type { ForegroundWindow } from '@nex/shared';
import type { AppKind, ResumeItemKind, TrackedApplication, TrackedAppPermissions, TrackingLevel, WorknexSettings } from '../types';

/**
 * Privacy engine — the hard boundary of WorkNEX.
 *
 *   No consent, no tracking.
 *   Being visible to the operating system is not permission for WorkNEX to remember it.
 *
 * WorkNEX uses an ALLOWLIST: only applications the user explicitly added are observed, and only at the level granted.
 * `sanitizeActivity()` is the single gate between the OS and WorkNEX. For any app not on the list it returns `null`:
 * nothing downstream (activity, contexts, timeline, events, logs, disk) ever sees that app — not even its name.
 *
 * Never collected, by design (there is no code path for these): screenshots, keystrokes, clipboard,
 * page/document content, audio, browser history.
 */

export const DEFAULT_SETTINGS: WorknexSettings = {
  trackedApplications: [],
  trackWindowTitlesByDefault: false,
  trackFileMetadataByDefault: false,
  trackUrlsByDefault: false,
  excludedPaths: [],
  paused: false,
  retentionDays: 30,
  confirmBeforeOpen: true,
  defaultResume: { folder: true, 'open-with': true, terminal: false, file: true, 'service-url': true, url: false, devnex: true, app: false },
  idleMinutes: 10,
};

export const RETENTION_CHOICES = [7, 30, 90] as const;
const RESUME_KINDS: ResumeItemKind[] = ['folder', 'open-with', 'terminal', 'file', 'service-url', 'url', 'devnex', 'app'];

/** Apps whose window titles commonly reveal passwords or private conversations (the picker warns about them). */
const SENSITIVE = /(1password|bitwarden|keepass|keychain|dashlane|lastpass|passwords|enpass|line|whatsapp|telegram|signal|messenger|messages|wechat|discord|mail|outlook)/i;
export const isSensitiveApp = (name: string, id = '') => SENSITIVE.test(`${name} ${id}`);

/**
 * What each level allows. Browsers: the window title IS the tab title, so it needs the browser-title grant.
 * URLs are never part of a level — always a separate, explicit opt-in.
 */
export function permissionsFor(level: TrackingLevel, kind: AppKind, url = false): TrackedAppPermissions {
  const browser = kind === 'browser';
  return {
    presence: true,
    windowTitle: level >= 2 && !browser,
    fileMetadata: level >= 3 && !browser,
    browserTitle: level >= 3 && browser,
    url: browser && level >= 2 && url,
  };
}

/** Initial level for a newly added app, from the "by default" settings (all off → presence only). */
export const defaultLevel = (s: Pick<WorknexSettings, 'trackWindowTitlesByDefault' | 'trackFileMetadataByDefault'>): TrackingLevel =>
  s.trackFileMetadataByDefault ? 3 : s.trackWindowTitlesByDefault ? 2 : 1;

export const trackedAppId = (applicationId: string) => createHash('sha1').update(applicationId.toLowerCase()).digest('hex').slice(0, 12);

/** Stable, platform-safe identity of a running app: bundle id (macOS) or lower-cased executable path (Windows). */
export function applicationIdOf(fw: Pick<ForegroundWindow, 'bundleId' | 'path' | 'key'>): string | null {
  return fw.bundleId ?? fw.key ?? (fw.path ? fw.path.toLowerCase() : null);
}

const KINDS: AppKind[] = ['editor', 'terminal', 'browser', 'meeting', 'document', 'other'];
function normalizeTracked(raw: unknown): TrackedApplication | null {
  const r = (raw ?? {}) as Partial<TrackedApplication>;
  if (typeof r.applicationId !== 'string' || !r.applicationId.trim() || typeof r.displayName !== 'string') return null;
  const kind = KINDS.includes(r.kind as AppKind) ? (r.kind as AppKind) : 'other';
  const level: TrackingLevel = r.level === 2 || r.level === 3 ? r.level : 1;
  const url = !!r.permissions?.url;
  return {
    id: trackedAppId(r.applicationId), applicationId: r.applicationId.slice(0, 500), displayName: r.displayName.slice(0, 120),
    executable: typeof r.executable === 'string' ? r.executable.slice(0, 500) : undefined,
    bundleId: typeof r.bundleId === 'string' ? r.bundleId.slice(0, 200) : undefined,
    kind, enabled: r.enabled !== false, level, permissions: permissionsFor(level, kind, url),
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : new Date(0).toISOString(),
  };
}

const strList = (v: unknown, max = 100) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))].slice(0, max).map(x => x.slice(0, 300)) : null;

/** Accepts untrusted input (settings file or API body) and returns complete, valid settings. Unknown/legacy keys are dropped. */
export function normalizeSettings(raw: unknown, base: WorknexSettings = DEFAULT_SETTINGS): WorknexSettings {
  const r = (raw ?? {}) as Partial<Record<keyof WorknexSettings, unknown>>;
  const bool = (k: keyof WorknexSettings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (base[k] as boolean));
  const days = Number(r.retentionDays);
  const idle = Number(r.idleMinutes);
  const dr = (r.defaultResume ?? {}) as Record<string, unknown>;
  const apps = Array.isArray(r.trackedApplications)
    ? r.trackedApplications.map(normalizeTracked).filter((a): a is TrackedApplication => !!a).filter((a, i, all) => all.findIndex(b => b.id === a.id) === i).slice(0, 200)
    : base.trackedApplications;
  return {
    trackedApplications: apps,
    trackWindowTitlesByDefault: bool('trackWindowTitlesByDefault'),
    trackFileMetadataByDefault: bool('trackFileMetadataByDefault'),
    trackUrlsByDefault: bool('trackUrlsByDefault'),
    excludedPaths: strList(r.excludedPaths) ?? base.excludedPaths,
    paused: bool('paused'),
    retentionDays: Number.isInteger(days) && days >= 1 && days <= 365 ? days : base.retentionDays,
    confirmBeforeOpen: bool('confirmBeforeOpen'),
    defaultResume: Object.fromEntries(RESUME_KINDS.map(k => [k, typeof dr[k] === 'boolean' ? dr[k] : base.defaultResume[k]])) as WorknexSettings['defaultResume'],
    idleMinutes: Number.isInteger(idle) && idle >= 2 && idle <= 120 ? idle : base.idleMinutes,
  };
}

/** The tracked entry for a front window, matched by stable identity only (bundle id / executable path), never by display name. */
export function trackedAppFor(fw: Pick<ForegroundWindow, 'bundleId' | 'path' | 'key'>, s: Pick<WorknexSettings, 'trackedApplications'>): TrackedApplication | null {
  const ids = [fw.bundleId, fw.key, fw.path?.toLowerCase()].filter((x): x is string => !!x).map(x => x.toLowerCase());
  if (!ids.length) return null;
  return s.trackedApplications.find(a => a.enabled && [a.applicationId, a.bundleId, a.executable?.toLowerCase()].filter((x): x is string => !!x).some(x => ids.includes(x.toLowerCase()))) ?? null;
}

export function isApplicationAllowed(fw: Pick<ForegroundWindow, 'bundleId' | 'path' | 'key'>, s: Pick<WorknexSettings, 'trackedApplications'>): boolean {
  return !!trackedAppFor(fw, s);
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** A path inside (or equal to) any excluded folder. */
export function isExcludedPath(path: string | null | undefined, excluded: string[]): boolean {
  if (!path || !excluded.length) return false;
  const p = normPath(path);
  return excluded.map(normPath).filter(Boolean).some(e => p === e || p.startsWith(`${e}/`));
}

/** Titles of excluded folders' files must not leak: a title mentioning an excluded folder is dropped entirely. */
export const titleMentionsExcluded = (title: string, excluded: string[]) =>
  excluded.some(e => { const base = e.replace(/[\\/]+$/, '').split(/[\\/]/).pop(); return !!base && base.length >= 3 && title.toLowerCase().includes(base.toLowerCase()); });

export type SanitizedActivity =
  | { kind: 'idle' }
  | { kind: 'app'; fw: ForegroundWindow; app: TrackedApplication };

/**
 * The ingestion gate. Returns null — drop, don't persist, don't group, don't log — when:
 *   WorkNEX is paused · nothing is in front · the app is not on the allowlist (or disabled).
 * For allowed apps it strips everything the app's permission level doesn't grant.
 * Idle is only reported for allowed apps (so idleness can't reveal anything about other apps either).
 */
export function sanitizeActivity(fw: ForegroundWindow | null, s: WorknexSettings, idleAfterMs: number): SanitizedActivity | null {
  if (s.paused || !fw) return null;
  const app = trackedAppFor(fw, s);
  if (!app) return null;
  if (fw.idleMs != null && fw.idleMs >= idleAfterMs) return { kind: 'idle' };
  const p = app.permissions;
  const titleAllowed = app.kind === 'browser' ? p.browserTitle : p.windowTitle;
  let title = titleAllowed ? fw.title : null;
  if (title && titleMentionsExcluded(title, s.excludedPaths)) title = null;
  // The user's name for the app is what WorkNEX shows; OS details beyond identity are not kept.
  return { kind: 'app', app, fw: { ...fw, appName: app.displayName, title, titleStatus: titleAllowed ? fw.titleStatus : 'off' } };
}

/** Does any tracked app need the window title (so the OS is only asked when someone granted it)? */
export const needsTitle = (app: TrackedApplication | null) => !!app && (app.kind === 'browser' ? app.permissions.browserTitle : app.permissions.windowTitle);
