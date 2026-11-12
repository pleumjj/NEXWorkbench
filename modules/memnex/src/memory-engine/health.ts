import type { MemoryReading } from '@nex/shared';
import type { Health, Signal } from '../types';

/** Deterministic thresholds (PRD §12). Kept in one object so they can become user settings later. */
export const THRESHOLDS = {
  moderateUsedPct: 70,
  highUsedPct: 85,
  criticalUsedPct: 95,
  /** Swap-out rate that counts as "actively swapping", bytes/sec averaged over the window. */
  swapRisingBytesPerSec: 1 * 1024 ** 2,
  /** Not in front for this long (while the user was present) → inactive. */
  idleMinutes: 20,
  /** Below this, closing an idle app is not worth interrupting the user. */
  inactiveMinBytes: 200 * 1024 ** 2,
  /** Background CPU (sum of per-core %) above this means the app is doing work (sync, render, build). */
  busyCpuPct: 5,
};

const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export function assessHealth(m: MemoryReading, swapRate: number | null): { state: Health; rationale: string; signals: Signal[]; swapRising: boolean } {
  const usedPct = (m.used / m.total) * 100;
  const swapRising = swapRate != null && swapRate >= THRESHOLDS.swapRisingBytesPerSec;
  const signals: Signal[] = [];

  if (m.pressure) {
    signals.push({ label: 'OS memory pressure', value: m.pressure === 'normal' ? 'Normal' : m.pressure === 'warn' ? 'Warning' : 'Critical', tone: m.pressure === 'normal' ? 'ok' : m.pressure === 'warn' ? 'warn' : 'bad' });
  }
  signals.push({ label: 'Memory used', value: `${usedPct.toFixed(0)}%`, tone: usedPct >= THRESHOLDS.highUsedPct ? 'warn' : 'ok' });
  if (m.compressed > 0) signals.push({ label: 'Compressed', value: gb(m.compressed), tone: m.compressed > m.total * 0.25 ? 'warn' : 'ok' });
  signals.push({ label: 'Swap activity', value: swapRate == null ? 'Measuring…' : swapRising ? `${gb(swapRate)}/s` : 'Idle', tone: swapRising ? 'bad' : 'ok' });

  let state: Health;
  let rationale: string;
  if (m.pressure) {
    // macOS reports pressure directly — trust it over any percentage we compute.
    if (m.pressure === 'critical') { state = 'Critical'; rationale = 'macOS reports critical memory pressure. Closing an idle app will help immediately.'; }
    else if (m.pressure === 'warn' || swapRising) {
      state = 'High';
      rationale = swapRising
        ? 'The system is actively moving memory to disk. Closing an app you are not using will improve responsiveness.'
        : 'macOS reports elevated memory pressure. Closing an app you are not using may improve responsiveness.';
    } else if (usedPct >= THRESHOLDS.highUsedPct) { state = 'Moderate'; rationale = 'Memory is well used, but macOS reports normal pressure. No action needed.'; }
    else { state = 'Healthy'; rationale = 'Memory pressure is normal. Your system is running comfortably.'; }
  } else {
    if (usedPct >= THRESHOLDS.criticalUsedPct && swapRising) { state = 'Critical'; rationale = 'Almost no memory is available and the system is paging to disk.'; }
    else if (usedPct >= THRESHOLDS.highUsedPct || swapRising) { state = 'High'; rationale = swapRising ? 'The system is actively paging to disk. Closing an idle app will improve responsiveness.' : 'Available memory is low. Closing an idle app may improve responsiveness.'; }
    else if (usedPct >= THRESHOLDS.moderateUsedPct) { state = 'Moderate'; rationale = 'Memory is well used, but there is headroom. No action needed.'; }
    else { state = 'Healthy'; rationale = 'Plenty of memory is available. Your system is running comfortably.'; }
  }
  return { state, rationale, signals, swapRising };
}
