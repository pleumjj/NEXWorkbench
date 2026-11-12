import { describeProcess, type ProcessGroup } from '@nex/process-core';
import type { AppKind, AppSummary, Growth, Health, ProcessStatus } from '../types';
import { THRESHOLDS } from '../memory-engine/health';
import type { Activity } from './activity';

export const fmtIdle = (min: number) =>
  min < 60 ? `${Math.round(min)} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} day${min >= 2880 ? 's' : ''}`;
const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export type RecommendOptions = {
  health: Health;
  bundleIds: Map<string, string | null>;
  /** Protection decided by the protection engine. */
  protectionOf: (g: ProcessGroup) => { status: ProcessStatus; reason: string } | null;
  activityKey: (a: { bundleId: string | null; path: string | null }) => string | null;
  activity: (key: string | null, pids: number[]) => Activity;
  growth: (id: string) => Growth | null;
  isMuted: (name: string) => boolean;
};

const kindOf = (g: ProcessGroup): AppKind => (g.kind === 'self' ? 'memnex' : g.kind);

/**
 * Smart Cleanup suggests apps you are NOT using — size alone never makes an app a candidate.
 * Pure function over process groups + observations, so it is fully testable.
 */
export function recommend(groups: ProcessGroup[], opts: RecommendOptions): AppSummary[] {
  const underPressure = opts.health === 'High' || opts.health === 'Critical';
  return groups.map(g => {
    const kind = kindOf(g);
    const bundleId = g.path ? opts.bundleIds.get(g.path) ?? null : null;
    const act = opts.activity(opts.activityKey({ bundleId, path: g.path }), g.pids);
    const growth = kind === 'app' || kind === 'cli' ? opts.growth(g.id) : null;

    const lock = opts.protectionOf(g);
    let status: ProcessStatus = lock?.status ?? 'Normal';
    const reasons: string[] = lock ? [lock.reason] : [];

    const eligible = status === 'Normal' && kind === 'app';
    const idle = !act.activeNow && act.idleMinutes != null && act.idleMinutes >= THRESHOLDS.idleMinutes;
    const quiet = g.cpu < THRESHOLDS.busyCpuPct;
    const idleEnough = eligible && idle && quiet && g.memory >= THRESHOLDS.inactiveMinBytes;
    // Learned preference: the user kept this app open the last few times it was suggested.
    const muted = idleEnough && opts.isMuted(g.name);
    const inactive = idleEnough && !muted;
    const recommended = inactive && underPressure;
    const suggested = inactive && !underPressure;
    if (muted) reasons.push('Idle, but you usually keep it open');
    else if (inactive) {
      if (recommended) status = 'Review';
      reasons.push(`Not used for ${act.atLeast ? 'at least ' : ''}${fmtIdle(act.idleMinutes!)}`, `${fmt(g.memory)} in memory`, 'Idle in background');
    } else if (eligible && act.activeNow) reasons.push('In use now');
    else if (eligible && idle && !quiet) reasons.push('Not in front, but working in the background');
    else if (eligible && act.idleMinutes != null && act.idleMinutes < THRESHOLDS.idleMinutes) reasons.push(`Used ${Math.max(1, Math.round(act.idleMinutes))} min ago`);
    if (growth && status !== 'System Critical') {
      reasons.push(`Memory grew ${fmt(growth.bytes)} in ${growth.minutes} min${growth.top ? `, mostly in ${growth.top.name}` : ''}`);
    }

    const main = g.items.find(p => p.pid === g.mainPid) ?? g.items[0];
    return {
      id: g.id, name: g.name, kind, path: g.path, bundleId,
      pids: g.pids, mainPid: g.mainPid, memory: g.memory, cpu: g.cpu, status, reasons, recommended, suggested,
      activeNow: act.activeNow, idleMinutes: act.idleMinutes, idleAtLeast: act.atLeast, growth,
      about: kind === 'system' ? 'Core operating system services. MemNEX never controls these.'
        : kind === 'memnex' ? 'NEX Workbench’s own API and web servers.'
        : kind === 'cli' ? describeProcess(g.name, main?.command) : null,
    };
  }).sort((a, b) => b.memory - a.memory);
}
