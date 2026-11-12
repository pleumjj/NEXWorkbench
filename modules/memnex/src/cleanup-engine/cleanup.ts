import type { AppSummary, CleanupPreview, ProcessItem, Snapshot } from '../types';

/** Which apps a cleanup may act on: GUI apps that are neither system, self, host nor protected. */
export const cleanable = (a: AppSummary) => a.kind === 'app' && (a.status === 'Normal' || a.status === 'Review');

export function buildPreview(s: Snapshot): CleanupPreview {
  const candidates = s.apps.filter(a => a.recommended);
  const optional = s.apps.filter(a => a.suggested);
  const restart = s.apps.filter(a => a.growth && cleanable(a));
  const busyLarge = s.apps.filter(a => a.kind === 'app' && a.status === 'Normal' && !a.recommended && !a.suggested && a.memory >= 1024 ** 3);
  const learning = s.watchingMinutes < 20;
  let note: string;
  if (candidates.length) note = 'These apps haven’t been used for a while and are idle in the background. Nothing is closed until you confirm.';
  else if (s.memory.state === 'Healthy' || s.memory.state === 'Moderate') note = 'No cleanup necessary — memory pressure is normal.';
  else if (learning) note = `MemNEX has watched app usage for ${s.watchingMinutes} min. Inactive-app suggestions need about 20 min of observation.`;
  else if (busyLarge.length) note = `The apps using the most memory (${busyLarge.slice(0, 3).map(a => a.name).join(', ')}) are in use, so MemNEX won’t suggest closing them.`;
  else note = 'No inactive app is using enough memory to be worth closing.';
  return { state: s.memory.state, candidates, optional, restart, reclaimable: candidates.reduce((n, a) => n + a.memory, 0), learning, watchingMinutes: s.watchingMinutes, note };
}

/** Outcome of a cleanup measured against the real process list afterwards (not an estimate). */
export function summarizeCleanup(selected: AppSummary[], results: PromiseSettledResult<unknown>[], after: ProcessItem[]) {
  const alive = new Set(after.map(p => p.pid));
  const closed: AppSummary[] = [], stillRunning: string[] = [], failed: { name: string; reason: string }[] = [];
  let released = 0;
  selected.forEach((a, i) => {
    const r = results[i];
    if (r?.status === 'rejected') { failed.push({ name: a.name, reason: (r.reason as Error)?.message ?? 'Application refused graceful close.' }); return; }
    const remaining = new Set(a.pids.filter(p => alive.has(p)));
    if (alive.has(a.mainPid)) stillRunning.push(a.name); else closed.push(a);
    const remainingMem = after.filter(p => remaining.has(p.pid)).reduce((n, p) => n + p.memory, 0);
    released += Math.max(0, a.memory - remainingMem);
  });
  return { closed, stillRunning, failed, released };
}
