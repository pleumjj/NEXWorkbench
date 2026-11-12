/**
 * WorkNEX domain model — work continuity, not surveillance.
 * No consent, no tracking: only applications the user explicitly added (the allowlist) are ever observed,
 * and only at the detail level the user granted. Never content, keystrokes, clipboard or screenshots.
 * Raw activity lives in memory; only derived contexts are stored.
 */

/** 1 = presence (app + time), 2 = context (+ window title, project/folder), 3 = extended (+ files, tab titles; URL is a separate opt-in). */
export type TrackingLevel = 1 | 2 | 3;

export interface TrackedAppPermissions {
  presence: boolean;
  windowTitle: boolean;
  fileMetadata: boolean;
  browserTitle: boolean;
  url: boolean;
}

/** An application the user explicitly allowed WorkNEX to observe. */
export interface TrackedApplication {
  id: string;
  /** Stable identity: bundle id on macOS, lower-cased executable path on Windows. Never just a display name. */
  applicationId: string;
  displayName: string;
  executable?: string;
  bundleId?: string;
  kind: AppKind;
  enabled: boolean;
  level: TrackingLevel;
  permissions: TrackedAppPermissions;
  addedAt: string;
}

/** An app the user could choose to track (discovery is not consent — nothing is added automatically). */
export interface AvailableApplication {
  applicationId: string;
  displayName: string;
  bundleId?: string;
  executable?: string;
  kind: AppKind;
  running: boolean;
  tracked: boolean;
  /** Apps whose titles commonly reveal secrets or private conversations. */
  sensitive: boolean;
}

export type AppKind = 'editor' | 'terminal' | 'browser' | 'meeting' | 'document' | 'other';
export type ContextType = 'development' | 'document' | 'meeting' | 'research' | 'general';

/** One normalized observation of the front window (in memory only, short-lived). */
export interface ActivityEvent {
  id: string;
  timestamp: string;
  app: string;
  appKey: string | null;
  appKind: AppKind;
  processId?: number;
  /** Only when title tracking is on and the app is not excluded. */
  windowTitle?: string;
  /** File name (and full path when the OS reports it). */
  fileName?: string;
  filePath?: string;
  projectPath?: string;
  projectId?: string;
  projectName?: string;
  /** Only when URL tracking is on (localhost URLs follow the same switch). */
  url?: string;
  /** How the project/file was identified. */
  signals: string[];
  source: 'foreground';
}

export interface WorkAppReference { name: string; key: string | null; bundleId: string | null; path: string | null; seconds: number; kind: AppKind }
/** `appKey` records which tracked app the reference came from, so removing an app can delete its history. */
export interface WorkFileReference { name: string; path: string | null; lastSeenAt: string; appKey?: string | null }
export interface WorkUrlReference { url: string; title: string | null; lastSeenAt: string; appKey?: string | null }
export interface WorkSpan { start: string; end: string }
export interface Interruption { at: string; by: string; kind: AppKind | 'idle' }

export interface WorkContext {
  id: string;
  /** Grouping key, e.g. project:<id>, doc:<stem>, meeting:<app>, app:<key>. */
  key: string;
  title: string;
  subtitle?: string;
  type: ContextType;
  startedAt: string;
  endedAt?: string;
  lastActiveAt: string;
  spans: WorkSpan[];
  applications: WorkAppReference[];
  files: WorkFileReference[];
  urls: WorkUrlReference[];
  projectPath?: string;
  projectId?: string;
  gitBranch?: string;
  /** Internal grouping confidence (0–1). Low-confidence contexts are never merged. */
  confidence: number;
  isActive: boolean;
  isSaved: boolean;
  sourceSignals: string[];
  /** Why the context stopped, when the evidence is clear ("Context changed when Zoom became active"). */
  interruptions: Interruption[];
  /** Last window title seen (only from apps with title permission). */
  lastTitle?: string;
  lastTitleAppKey?: string | null;
}

/** A user-made checkpoint: enough to resume, never application memory/state. */
export interface SavedContext {
  id: string;
  contextId: string | null;
  label: string;
  note: string;
  savedAt: string;
  lastResumedAt: string | null;
  type: ContextType;
  projectPath?: string;
  projectId?: string;
  gitBranch?: string;
  applications: Omit<WorkAppReference, 'seconds'>[];
  files: Omit<WorkFileReference, 'lastSeenAt'>[];
  urls: Omit<WorkUrlReference, 'lastSeenAt'>[];
  services: { name: string; port: number | null }[];
}

export type ResumeItemKind = 'folder' | 'open-with' | 'terminal' | 'file' | 'service-url' | 'url' | 'devnex' | 'app';
export interface ResumeItem {
  id: string;
  kind: ResumeItemKind;
  label: string;
  detail: string;
  /** Default checkbox state (from Settings › Default resume actions). */
  selected: boolean;
  /** For devnex items: an in-app route the browser navigates to. */
  route?: string;
  /** Why it can't be opened right now (missing file, service not running…). Unavailable items are never selected. */
  unavailable?: string;
}
export interface ResumePlan { title: string; source: 'context' | 'saved'; sourceId: string; items: ResumeItem[] }
export interface ResumeResult { opened: string[]; failed: { label: string; reason: string }[]; routes: string[] }

export interface WorknexSettings {
  /** The allowlist. Empty on a fresh install: WorkNEX tracks nothing until the user adds apps. */
  trackedApplications: TrackedApplication[];
  /** Defaults applied when the user adds an app (all off: new apps start at presence only). */
  trackWindowTitlesByDefault: boolean;
  trackFileMetadataByDefault: boolean;
  trackUrlsByDefault: boolean;
  /** Folders whose files/projects are never recorded, even from tracked apps. */
  excludedPaths: string[];
  /** Pause WorkNEX: no collection from any app until the user resumes. */
  paused: boolean;
  retentionDays: number;
  confirmBeforeOpen: boolean;
  defaultResume: Record<ResumeItemKind, boolean>;
  /** Idle longer than this ends the current span. */
  idleMinutes: number;
}

/** What DevNEX knows about a project — WorkNEX never rediscovers it. Provided by the Workbench wiring. */
export interface KnownProject {
  id: string;
  name: string;
  path: string;
  /** Ports of running services: used to tie localhost URLs to the project. */
  services: { name: string; port: number | null; running: boolean }[];
}
export interface ProjectDirectory {
  projects(): Promise<KnownProject[]>;
  gitBranch(path: string): Promise<string | null>;
}

export type TimelineEntry = { contextId: string; title: string; type: ContextType; start: string; end: string | null; brief: string[] };
export type WhereWasI = {
  context: WorkContext;
  isActive: boolean;
  recentFile: string | null;
  related: string[];
  changedWhen: string | null;
} | null;

export interface Insights {
  day: string;
  majorContexts: number;
  longestSpanMinutes: number;
  longestSpanTitle: string | null;
  averageContextMinutes: number;
  observations: string[];
}

export interface WorknexStatus {
  collecting: boolean;
  paused: boolean;
  /** Number of enabled tracked apps; 0 = not configured (nothing is tracked). */
  trackedApps: number;
  /** Tracked apps allowed more than presence (titles / project / files). */
  detailedApps: number;
  /** Tracked apps allowed to record URLs. */
  urlApps: number;
  /** "full" | "limited" (no titles) | "unavailable" (no foreground info at all). */
  detection: 'full' | 'limited' | 'unavailable';
  detectionDetail: string | null;
  activeContext: { id: string; title: string; type: ContextType; since: string } | null;
  todayContexts: number;
  savedContexts: number;
  lastSampleAt: string | null;
}
