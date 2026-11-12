/**
 * FileNEX domain model — local file intelligence. Find the work, not the filename.
 * No folder permission, no indexing: only files inside locations the user explicitly added are ever recorded.
 * Metadata only (name, path, size, dates, type) — file contents are never read, except hashing size-matched
 * candidates to confirm exact duplicates.
 */

export type FileType = 'presentation' | 'spreadsheet' | 'document' | 'pdf' | 'text' | 'data' | 'code' | 'image' | 'design' | 'archive' | 'video' | 'audio' | 'other';

export interface FileRecord {
  id: string;
  name: string;
  extension: string;
  path: string;
  parentPath: string;
  locationId: string;
  sizeBytes: number;
  createdAt: string | null;
  modifiedAt: string;
  fileType: FileType;
  /** Content hash, only for size-matched duplicate candidates. */
  hash: string | null;
  indexedAt: string;
}

export type LocationState = 'idle' | 'scanning' | 'paused' | 'unavailable' | 'error';

/** A folder the user explicitly allowed FileNEX to index. */
export interface IndexedLocation {
  id: string;
  path: string;
  label: string;
  paused: boolean;
  addedAt: string;
  /** Extra folder names to skip in this location (in addition to the global list). */
  excludedFolders: string[];
}

export interface LocationStatus extends IndexedLocation {
  state: LocationState;
  files: number;
  scanned: number;
  lastScanAt: string | null;
  error: string | null;
}

export interface FilenexSettings {
  locations: IndexedLocation[];
  /** Global pause: no scanning or index updates; search over the existing index keeps working. */
  paused: boolean;
  /** Minutes between reconciliation scans (0 = only on demand / file changes). */
  scanEveryMinutes: number;
  /** Defer background scanning while the machine is under memory/CPU pressure. */
  deferUnderPressure: boolean;
  /** Watch approved folders for changes (debounced re-scan of that folder). */
  watchChanges: boolean;
  ignoredFolders: string[];
  ignoredExtensions: string[];
  excludeSensitive: boolean;
  includeHidden: boolean;
}

/** What WorkNEX knows (wired by the Workbench): FileNEX consumes it, never re-tracks. */
export interface WorkContextRef {
  id: string;
  title: string;
  type: string;
  projectId?: string;
  projectPath?: string;
  startedAt: string;
  lastActiveAt: string;
  isActive: boolean;
  files: { name: string; path: string | null }[];
}
/** What DevNEX knows. Registration does NOT grant indexing permission. */
export interface ProjectRef { id: string; name: string; path: string }
export interface ContextSources {
  contexts(): Promise<WorkContextRef[]>;
  projects(): Promise<ProjectRef[]>;
  /** DevNEX activity per project (running services, compose projects) — for storage recommendations only. */
  projectActivity?(): Promise<import('./storage-types').ProjectActivity[]>;
  /** Read-only Git context of a project folder (branch, changes). */
  git?(path: string): Promise<import('./storage-types').GitContext | null>;
}

export type Reason = string;
export interface SearchHit {
  file: FileRecord;
  score: number;
  reasons: Reason[];
  project: ProjectRef | null;
  contexts: { id: string; title: string }[];
  latestHint: 'latest' | 'older' | null;
}
export interface ParsedQuery {
  terms: string[];
  type: FileType | null;
  modifiedFrom: number | null;
  modifiedTo: number | null;
  interpreted: string[];
}
export interface RelatedFile { file: FileRecord; score: number; reasons: Reason[] }
export interface VersionGroup { key: string; label: string; files: FileRecord[]; latestId: string; reasons: Reason[]; highestVersionId: string | null }
export interface DuplicateGroup { kind: 'exact' | 'possible'; key: string; files: FileRecord[]; reasons: Reason[] }
export interface Collection { id: string; name: string; createdAt: string; fileIds: string[] }
