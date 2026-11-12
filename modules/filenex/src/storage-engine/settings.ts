import type { StorageSettings, StorageThreshold } from '../storage-types';
import { DEFAULT_THRESHOLDS } from '../disk-analyzer';

/** Conservative defaults: analysis on (approved folders only), history on, 30 days; nothing is ever deleted. */
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  enabled: true,
  paused: false,
  scanEveryHours: 24,
  largeFileThresholdMb: 1024,
  historyEnabled: true,
  historyRetentionDays: 30,
  analyzeDevProjects: true,
  detectDependencies: true,
  detectBuildArtifacts: true,
  dockerStorage: true,
  sharedCaches: false,
  pauseOnHighCpu: true,
  pauseOnMemoryPressure: true,
  inactiveDays: 90,
  thresholds: DEFAULT_THRESHOLDS,
};

const pick = <T extends number>(v: unknown, allowed: T[], fallback: T): T => (allowed.includes(Number(v) as T) ? (Number(v) as T) : fallback);
const threshold = (v: unknown, base: StorageThreshold): StorageThreshold => {
  const r = (v ?? {}) as Partial<StorageThreshold>;
  const gb = Number(r.gb), pct = Number(r.percent);
  return { gb: Number.isFinite(gb) && gb >= 1 && gb <= 10_000 ? gb : base.gb, percent: Number.isFinite(pct) && pct >= 1 && pct <= 50 ? pct : base.percent };
};

export function normalizeStorageSettings(raw: unknown, base: StorageSettings = DEFAULT_STORAGE_SETTINGS): StorageSettings {
  const r = (raw ?? {}) as Partial<Record<keyof StorageSettings, unknown>>;
  const bool = (k: keyof StorageSettings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (base[k] as boolean));
  const t = (r.thresholds ?? {}) as Partial<Record<'attention' | 'low' | 'critical', unknown>>;
  let thresholds = { attention: threshold(t.attention, base.thresholds.attention), low: threshold(t.low, base.thresholds.low), critical: threshold(t.critical, base.thresholds.critical) };
  // Levels must stay ordered: critical < low < attention.
  if (!(thresholds.critical.gb < thresholds.low.gb && thresholds.low.gb < thresholds.attention.gb)) thresholds = base.thresholds;
  return {
    enabled: bool('enabled'),
    paused: bool('paused'),
    scanEveryHours: pick(r.scanEveryHours, [0, 6, 24, 168], base.scanEveryHours),
    largeFileThresholdMb: pick(r.largeFileThresholdMb, [100, 500, 1024, 5120], base.largeFileThresholdMb),
    historyEnabled: bool('historyEnabled'),
    historyRetentionDays: pick(r.historyRetentionDays, [7, 30, 90, 365], base.historyRetentionDays),
    analyzeDevProjects: bool('analyzeDevProjects'),
    detectDependencies: bool('detectDependencies'),
    detectBuildArtifacts: bool('detectBuildArtifacts'),
    dockerStorage: bool('dockerStorage'),
    sharedCaches: bool('sharedCaches'),
    pauseOnHighCpu: bool('pauseOnHighCpu'),
    pauseOnMemoryPressure: bool('pauseOnMemoryPressure'),
    inactiveDays: pick(r.inactiveDays, [30, 60, 90, 180, 365], base.inactiveDays),
    thresholds,
  };
}
