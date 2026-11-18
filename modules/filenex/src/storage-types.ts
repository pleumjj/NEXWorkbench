/**
 * FileNEX Storage Intelligence — domain model.
 *
 *   Know where your space went. Recover space without losing work. Analyze first. Delete deliberately.
 *
 * Storage analysis obeys the same allowlist as the file index: only folders the user added are walked.
 * It records sizes (and the names of large files / known developer folders) — never file contents.
 * Nothing is ever deleted automatically: cleanup is a preview of exact paths, and only items the user confirms (with
 * "Allow FileNEX to delete" turned on) are removed — regeneratable folders permanently, personal files to the Trash.
 */

export type StorageHealth = 'healthy' | 'attention' | 'low' | 'critical';
export type CleanupRisk = 'SAFE_TO_REVIEW' | 'REVIEW_CAREFULLY' | 'PROTECTED';
/** Where bytes inside a repository/folder belong. */
export type StorageCategory = 'source' | 'dependencies' | 'build' | 'cache' | 'logs' | 'git' | 'other';
export type StorageEntryType = StorageCategory | 'worktree' | 'docker' | 'shared-cache' | 'download' | 'large-file' | 'duplicate';
export type Runtime = 'node' | 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'php' | 'ruby' | 'generic';

export interface DiskVolume {
  path: string;
  label: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** The volume that holds the user's home folder (the one storage status is about). */
  primary: boolean;
}

export interface StorageThreshold { gb: number; percent: number }
/** A level applies when free space is below min(gb, percent × disk size) — GB on large disks, % on small ones. */
export interface StorageThresholds { attention: StorageThreshold; low: StorageThreshold; critical: StorageThreshold }

export interface StorageSettings {
  /** Storage analysis on/off (disk capacity is always shown — it needs no folder access). */
  enabled: boolean;
  paused: boolean;
  /** Hours between automatic analyses of approved folders (0 = only when I ask). */
  scanEveryHours: number;
  largeFileThresholdMb: number;
  historyEnabled: boolean;
  historyRetentionDays: number;
  analyzeDevProjects: boolean;
  detectDependencies: boolean;
  detectBuildArtifacts: boolean;
  dockerStorage: boolean;
  /** Opt-in: measure the total size of npm/pnpm/yarn caches (outside your folders; size only, no names). */
  sharedCaches: boolean;
  pauseOnHighCpu: boolean;
  pauseOnMemoryPressure: boolean;
  /** A repository with no activity for this many days is "inactive". */
  inactiveDays: number;
  thresholds: StorageThresholds;
  /** Let FileNEX remove items you confirm in a cleanup preview. Off by default; never automatic. */
  allowDelete: boolean;
}

/** A known developer folder found inside an approved location, measured as one unit. */
export interface ArtifactDir {
  path: string;
  /** Folder name, e.g. node_modules, .next, dist. */
  name: string;
  rule: string;
  category: StorageCategory;
  runtime: Runtime;
  regeneratable: boolean;
  bytes: number;
  files: number;
  /** Folder's own modification time (a proxy for "last changed"). */
  modifiedAt: string | null;
  measuredAt: string;
  /** Nearest folder with a project marker (package.json, Cargo.toml…), if any. */
  projectRoot: string | null;
}
/** *.log files outside log folders, grouped per folder. */
export interface LooseLogs { dir: string; bytes: number; files: number; newestAt: string | null }
export interface LargeFile { path: string; name: string; extension: string; bytes: number; modifiedAt: string; createdAt: string | null; inDownloads: boolean }
export interface DownloadItem { path: string; name: string; bytes: number; isDir: boolean; modifiedAt: string }
export interface FolderSize { path: string; name: string; depth: number; bytes: number }
/** Totals for one DevNEX project root, accumulated during the walk (artifacts are added separately). */
export interface RootTotals { path: string; totalBytes: number; sourceBytes: number; otherBytes: number; looseLogBytes: number; protectedBytes: number; newestSourceAt: string | null }

/** The latest analysis of one approved location. */
export interface LocationAnalysis {
  locationId: string;
  path: string;
  label: string;
  analyzedAt: string;
  durationMs: number;
  totalBytes: number;
  entries: number;
  errors: number;
  truncated: boolean;
  folders: FolderSize[];
  artifacts: ArtifactDir[];
  logs: LooseLogs[];
  largeFiles: LargeFile[];
  downloads: DownloadItem[];
  roots: RootTotals[];
  /** Git worktrees found in this location (folders whose `.git` is a file) — totals accumulated like project roots. */
  worktrees?: RootTotals[];
}

export interface StorageCategorySnapshot { key: string; label: string; kind: 'location' | 'folder' | 'repo' | 'docker' | 'shared'; bytes: number }
export interface StorageSnapshot {
  id: string;
  timestamp: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  categories?: StorageCategorySnapshot[];
}
export interface RepoStorageSnapshot {
  projectId: string;
  name: string;
  timestamp: string;
  totalBytes: number;
  sourceBytes: number;
  dependencyBytes: number;
  buildBytes: number;
  cacheBytes: number;
  logBytes: number;
  gitBytes: number;
  otherBytes: number;
}

export interface StorageEntry {
  id: string;
  path: string;
  name: string;
  type: StorageEntryType;
  bytes: number;
  risk: CleanupRisk;
  regeneratable: boolean;
  /** Counted in "potentially recoverable" (conservative: never protected data, never dependencies of active work). */
  recoverable: boolean;
  reason: string;
  explanation: string;
  regenerate?: string;
  projectId?: string;
  projectName?: string;
  lastUsedAt?: string | null;
  runtime?: Runtime;
  /** Git context only — never permission. */
  git?: 'ignored' | 'tracked' | 'untracked' | null;
  /** The entry is a whole folder (its bytes include everything inside it). */
  container?: boolean;
  /** Readable title, e.g. "frontend/node_modules" or a worktree's branch name. */
  label?: string;
  /** Readable context line, e.g. "topo · worktree fix/cr-075…". */
  detail?: string;
}

/** Read-only Git facts about a worktree (branch, last commit, uncommitted files) — context, never permission. */
export interface WorktreeGit { branch: string | null; lastCommitAt: string | null; lastCommitSubject: string | null; uncommitted: number; mainPath: string | null }

/** One Git worktree inside an approved folder (e.g. Claude Code agent worktrees in .claude/worktrees). */
export interface WorktreeStorage {
  path: string;
  /** Folder name, e.g. agent-a00dc7b27f994ff86. */
  folder: string;
  /** Readable name: the branch, or the folder when detached. */
  name: string;
  branch: string | null;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  uncommitted: number | null;
  mainPath: string | null;
  projectId?: string;
  projectName?: string;
  totalBytes: number;
  dependencyBytes: number;
  buildBytes: number;
  cacheBytes: number;
  sourceBytes: number;
  lastActiveAt: string | null;
  /** Uncommitted changes, or activity in the last 24 hours. */
  inUse: boolean;
  status: string;
}

export interface RepositoryStorage {
  projectId: string;
  name: string;
  path: string;
  available: boolean;
  /** Why analysis is unavailable (outside FileNEX locations, or not analyzed yet). */
  unavailableReason?: 'not-approved' | 'partial' | 'pending' | 'disabled';
  totalBytes: number;
  sourceBytes: number;
  dependencyBytes: number;
  buildBytes: number;
  cacheBytes: number;
  logBytes: number;
  gitBytes: number;
  otherBytes: number;
  /** Docker images/volumes attributed to the project (in Docker's own disk image — not part of the folder total). */
  dockerRelatedBytes?: number;
  recoverableEstimateBytes: number;
  lastActiveAt: string | null;
  lastActiveSource: 'worknex' | 'files' | null;
  isActiveProject: boolean;
  recentlyUsed: boolean;
  inactiveDays: number | null;
  runningServiceCount: number;
  analyzedAt: string | null;
  growth7dBytes: number | null;
  /** True when this project is inside another listed project (its bytes are already in the parent's total). */
  nested: boolean;
  /** Git worktrees of this project inside approved folders (their bytes are already in the categories above). */
  worktrees: WorktreeStorage[];
  breakdown: StorageEntry[];
}

export interface StorageForecast {
  enough: boolean;
  message: string;
  ratePerWeekBytes?: number;
  weeksTo90?: number | null;
  weeksToFull?: number | null;
  basisDays?: number;
}

/**
 * How a confirmed item is removed: `delete` = permanently (regeneratable folders — the Trash would not free space),
 * `trash` = to the OS Trash (your files), `git-worktree` = `git worktree remove` (never forced), `command` = the tool's own
 * cleanup command (Docker, package managers), `none` = FileNEX does not remove it (you decide outside FileNEX).
 */
export type CleanupMethod = 'delete' | 'trash' | 'git-worktree' | 'command' | 'none';

export interface CleanupCandidate extends StorageEntry {
  group: 'worktrees' | 'build' | 'cache' | 'dependencies' | 'logs' | 'downloads' | 'large-old' | 'duplicates' | 'docker' | 'shared-cache';
  method: CleanupMethod;
  /** For `command`: the exact argv FileNEX runs (no shell interpretation of user input). */
  command?: string[];
  /** FileNEX can remove it after confirmation (recoverable, not protected, has a method). */
  removable: boolean;
  /** Why FileNEX won't remove it (when not removable). */
  keepReason?: string;
}

export interface CleanupRunItem {
  id: string;
  label: string;
  path: string;
  method: CleanupMethod;
  bytes: number;
  state: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  message?: string;
  regenerate?: string | null;
}
export interface CleanupRun {
  id: string;
  state: 'running' | 'done';
  startedAt: string;
  finishedAt: string | null;
  items: CleanupRunItem[];
  /** Free space on the disk before / after (measured, not estimated). */
  freeBefore: number | null;
  freeAfter: number | null;
}
export interface CleanupHistoryEntry { at: string; label: string; path: string; method: CleanupMethod; bytes: number; ok: boolean; message?: string }

export interface DockerStorage {
  available: boolean;
  detail: string | null;
  images: { bytes: number; reclaimableBytes: number; count: number };
  containers: { bytes: number; reclaimableBytes: number; count: number };
  volumes: { bytes: number; reclaimableBytes: number; count: number };
  buildCache: { bytes: number; reclaimableBytes: number; count: number };
  /** Images + volumes attributed to compose projects (estimate by name). */
  byComposeProject: Record<string, number>;
  checkedAt: string;
}

export interface SharedCache { id: 'npm' | 'pnpm' | 'yarn'; label: string; path: string; bytes: number | null; measuredAt: string | null; clean: string; insideApprovedLocation: boolean }

/** Extra DevNEX context for storage decisions (activity, services, git). DevNEX identifies; FileNEX analyzes. */
export interface ProjectActivity {
  id: string;
  name: string;
  path: string;
  runningServices: number;
  status: string;
  composeProjects: string[];
}
export interface GitContext { isRepo: boolean; branch: string | null; changed: number; untracked: number }

/** One line of a suggested step: a readable name (relative to its approved folder), size and a short note. */
export interface PlanItem { id: string | null; label: string; path: string; bytes: number; note?: string }
export interface PlanStep {
  key: 'build' | 'idle-deps' | 'check-first' | 'your-call';
  title: string;
  /** Approximate bytes covered by the step's items (each byte once). */
  bytes: number;
  why: string;
  items: PlanItem[];
  /** Items not shown in `items`. */
  more: number;
  /** Things deliberately left out of this step, with the reason. */
  keep: { label: string; reason: string }[];
  /** Notes (e.g. "aim-dms-ui is installed in 2 places"). */
  notes: string[];
  /** Candidate ids this step covers (to select them in Cleanup Review). Empty for "ask first" steps. */
  ids: string[];
}
/** A deterministic, explainable cleanup plan — suggestions in order of gain vs. risk. Nothing is ever deleted. */
export interface CleanupPlan { generatedAt: string; headline: string; urgency: 'none' | 'soon' | 'now'; steps: PlanStep[] }
