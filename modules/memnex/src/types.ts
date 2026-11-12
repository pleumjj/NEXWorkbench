import type { Pressure, ProcessInfo } from '@nex/shared';

export type Health = 'Healthy' | 'Moderate' | 'High' | 'Critical';
export type ProcessStatus = 'Normal' | 'Review' | 'Protected' | 'System Critical';
/** 'memnex' = NEX Workbench's own processes (never controllable). */
export type AppKind = 'app' | 'cli' | 'system' | 'memnex';

export type ProcessItem = ProcessInfo & { app: string; protected: boolean; status?: ProcessStatus; reason?: string; about?: string | null };

export type Growth = { bytes: number; minutes: number; top: { pid: number; name: string; bytes: number } | null };

/** What MemNEX treats as one "application". `kind` decides which actions are allowed. */
export type AppSummary = {
  id: string;
  name: string;
  kind: AppKind;
  path: string | null;
  bundleId: string | null;
  pids: number[];
  mainPid: number;
  memory: number;
  cpu: number;
  status: ProcessStatus;
  reasons: string[];
  /** Under memory pressure and not in use → pre-selected in Smart Cleanup. */
  recommended: boolean;
  /** Not in use, but pressure is normal → offered as optional, never pre-selected. */
  suggested: boolean;
  activeNow: boolean;
  /** Minutes since last foreground use; null while MemNEX is still learning. */
  idleMinutes: number | null;
  /** true when the app was never seen in front since MemNEX started watching (idleMinutes is a lower bound). */
  idleAtLeast: boolean;
  /** Sustained memory growth (possible leak) → Restart suggestion. */
  growth: Growth | null;
  about: string | null;
};

export type Signal = { label: string; value: string; tone: 'ok' | 'warn' | 'bad' };
export type Recommendation = { pid: number; name: string; memory: number; reason: string };

export type InsightAction =
  | { kind: 'close'; appId: string; pid: number; name: string; label: string }
  | { kind: 'restart'; appId: string; pid: number; name: string; label: string }
  | { kind: 'review'; label: string };
export type Insight = { tone: 'ok' | 'watch' | 'act'; headline: string; detail: string | null; evidence: string[]; actions: InsightAction[] };

export type Snapshot = {
  memory: { total: number; used: number; available: number; percent: number; compressed: number; cached: number; state: Health; rationale: string; pressure: Pressure | null };
  swap: { total: number; used: number; percent: number; rising: boolean };
  signals: Signal[];
  cpu: { usage: number; cores: number; model: string };
  system: { uptime: number };
  processes: ProcessItem[];
  apps: AppSummary[];
  recommendations: Recommendation[];
  recentlyClosed: { id: string; name: string; closedAt: string }[];
  /** How long MemNEX has been observing app usage — recommendations need ≥ 20 min. */
  watchingMinutes: number;
  /** One-sentence diagnosis with evidence and actions. */
  insight: Insight;
  platform: string;
  updatedAt: string;
};

export type CleanupPreview = {
  state: Health; candidates: AppSummary[]; optional: AppSummary[]; restart: AppSummary[];
  reclaimable: number; learning: boolean; watchingMinutes: number; note: string;
};
export type CleanupResult = {
  before: number; after: number; recovered: number;
  closed: { id: string; name: string }[]; stillRunning: string[]; failed: { name: string; reason: string }[]; durationMs: number;
};
export type ActionOutcome = { ok: boolean; app: string; stillRunning: boolean; detail?: string; reopened?: boolean };
export type Preferences = { protectedApps: string[]; keptOpen: Record<string, number> };
