/**
 * @nex/shared — product-agnostic types shared by every NEX Workbench layer.
 * Nothing here may refer to MemNEX or DevNEX concepts.
 */

/** A process as reported by the OS, normalized across platforms. */
export type ProcessInfo = {
  pid: number;
  ppid?: number;
  /** Executable name (basename of comm / ProcessName). */
  name: string;
  /** Full command line (macOS) or executable path (Windows). */
  command: string;
  /** CPU % of one core (sum of per-core %; may exceed 100 on multi-core). */
  cpu: number;
  /** Resident memory in bytes. */
  memory: number;
  user: string;
  /** When the process started (ms since epoch, ±1 s). With pid it identifies one process — pids are reused. */
  startedAt?: number;
};

export type Pressure = 'normal' | 'warn' | 'critical';

/** Memory as the OS itself counts it (Activity Monitor / Task Manager definition of "used"). */
export type MemoryReading = {
  total: number;
  used: number;
  available: number;
  compressed: number;
  cached: number;
  swap: { total: number; used: number };
  /** Cumulative bytes written to swap — lets callers detect *active* swapping. */
  swapOutBytes: number | null;
  /** Pressure reported directly by the OS when it has such a signal (macOS). */
  pressure: Pressure | null;
};

export type HostInfo = {
  platform: NodeJS.Platform;
  osName: string;
  release: string;
  hostname: string;
  cpuModel: string;
  cores: number;
  totalMemory: number;
  uptime: number;
};

/** A listening TCP socket. */
export type PortInfo = {
  port: number;
  /** Local bind address, e.g. 127.0.0.1, 0.0.0.0, ::, * */
  address: string;
  pid: number | null;
  processName: string | null;
  protocol: 'tcp';
};

/** What the user is doing right now — used to tell "in use" from "idle". */
export type ForegroundInfo = { key: string | null; pid: number | null; idleMs: number | null };

/**
 * The window in front, as metadata only (never content, never screenshots).
 * `titleStatus` explains a missing title: off (not requested), needs-permission (macOS Accessibility), unavailable.
 */
export type ForegroundWindow = {
  appName: string | null;
  /** Same key as ForegroundInfo.key (bundle id on macOS, lower-cased exe path on Windows). */
  key: string | null;
  bundleId: string | null;
  path: string | null;
  pid: number | null;
  title: string | null;
  titleStatus: 'ok' | 'off' | 'unavailable' | 'needs-permission';
  idleMs: number | null;
};

/** Target for app-level actions (a whole GUI application, not a single pid). */
export type AppTarget = { mainPid: number; pids: number[]; bundleId: string | null; path: string | null };

export type ActionErrorCode = 'permission' | 'gone' | 'unsupported' | 'refused';

/* ───────────────────────── Workbench module contract ───────────────────────── */

export type Severity = 'info' | 'warning' | 'critical';

/** Something a module thinks the user should look at. Modules detect; the Workbench only aggregates. */
export interface AttentionItem {
  id: string;
  sourceModule: string;
  severity: Severity;
  title: string;
  description: string;
  /** Workbench route that resolves it, e.g. "/devnex/ports". */
  action?: string;
  actionLabel?: string;
  timestamp: string;
}

/** Compact operational summary for the Workbench home ("My NEX"). */
export interface ModuleStatus {
  id: string;
  name: string;
  tagline: string;
  route: string;
  /** not-configured: a module that does nothing until the user sets it up (e.g. WorkNEX with no tracked apps). Neutral, never an error. */
  state: 'healthy' | 'attention' | 'critical' | 'unavailable' | 'not-configured';
  headline: string;
  /** Up to four labelled figures, e.g. { label: 'Memory', value: '68%' }. */
  metrics: { label: string; value: string }[];
  detail?: string;
}

/** A command-palette entry. Workbench routes it; the module owns what it means. */
export interface NexCommand {
  id: string;
  title: string;
  group: string;
  route: string;
  keywords?: string;
}

/** One "Continue working" entry on Workbench Home (WorkNEX provides it; DevNEX is the fallback). */
export interface ContinueWorkingItem {
  id: string;
  title: string;
  subtitle?: string;
  sourceModule: string;
  lastActiveAt: string | null;
  isActive: boolean;
  branch?: string | null;
  path?: string | null;
  services: { name: string; port: number | null }[];
  /** Where "Resume" goes (the module shows a preview there first). */
  route: string;
}

/** Something that happened this session (in memory only). */
export interface ActivityEvent {
  id: string;
  sourceModule: string;
  type: string;
  title: string;
  timestamp: string;
}

export interface NexModule {
  id: string;
  name: string;
  route: string;
  description: string;
  getStatus(): Promise<ModuleStatus>;
  getAttentionItems(): Promise<AttentionItem[]>;
  getCommands?(): Promise<NexCommand[]>;
}

export type WorkspaceState = 'Healthy' | 'Attention' | 'Critical';

/** Deterministic overall state: any critical → Critical; any warning → Attention; else Healthy. */
export function workspaceState(items: Pick<AttentionItem, 'severity'>[], unavailable = 0): WorkspaceState {
  if (items.some(i => i.severity === 'critical')) return 'Critical';
  if (unavailable > 0 || items.some(i => i.severity === 'warning')) return 'Attention';
  return 'Healthy';
}
