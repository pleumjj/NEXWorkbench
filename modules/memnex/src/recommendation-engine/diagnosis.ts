import type { Pressure } from '@nex/shared';
import type { AppSummary, Health, Insight, InsightAction, ProcessItem } from '../types';
import { fmtIdle } from './recommend';

/**
 * "Why is my computer slow right now?" — one cause, the evidence behind it, and at most two actions.
 * Deterministic rules over signals MemNEX already has; it says nothing it can't back up.
 */
export type { Insight, InsightAction };

const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const list = (names: string[]) => (names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

export function diagnose(input: {
  state: Health; pressure: Pressure | null; swapRising: boolean; swapRate: number | null;
  compressed: number; total: number; cpuUsage: number; cores: number;
  apps: AppSummary[]; processes: ProcessItem[]; watchingMinutes: number;
}): Insight {
  const { state, apps, processes } = input;
  const evidence: string[] = [];
  if (input.pressure) evidence.push(`macOS pressure: ${input.pressure === 'normal' ? 'Normal' : input.pressure === 'warn' ? 'Warning' : 'Critical'}`);
  if (input.swapRising && input.swapRate) evidence.push(`Writing ${fmt(input.swapRate)}/s to swap`);
  if (input.compressed > input.total * 0.25) evidence.push(`${fmt(input.compressed)} compressed`);

  const userApps = apps.filter(a => a.kind === 'app' && (a.status === 'Normal' || a.status === 'Review'));
  const growing = userApps.filter(a => a.growth).sort((a, b) => b.growth!.bytes - a.growth!.bytes)[0];
  const idle = apps.filter(a => a.recommended || a.suggested).sort((a, b) => b.memory - a.memory);
  const proc = (name: string) => processes.filter(p => p.name.toLowerCase() === name);
  const cpuOf = (ps: ProcessItem[]) => ps.reduce((n, p) => n + p.cpu, 0);

  const restartAction = (a: AppSummary): InsightAction => ({ kind: 'restart', appId: a.id, pid: a.mainPid, name: a.name, label: `Restart ${a.name}` });
  const closeAction = (a: AppSummary): InsightAction => ({ kind: 'close', appId: a.id, pid: a.mainPid, name: a.name, label: `Close ${a.name}` });
  const growthLine = (a: AppSummary) => {
    const g = a.growth!;
    evidence.push(`${a.name}: +${fmt(g.bytes)} in ${g.minutes} min`);
    return g.top ? `, mostly in ${g.top.name}` : '';
  };

  // ── 1. Memory pressure: name the cause, not just the symptom.
  if (state === 'High' || state === 'Critical') {
    const swapping = input.swapRising ? ' and macOS is moving memory to disk' : '';
    if (growing) {
      const where = growthLine(growing);
      const actions: InsightAction[] = [restartAction(growing)];
      if (idle[0]) actions.push(closeAction(idle[0]));
      return { tone: 'act', headline: `${growing.name} has grown ${fmt(growing.growth!.bytes)} in ${growing.growth!.minutes} minutes${swapping}.`, detail: `That steady growth is the main reason memory is tight${where}. Restarting it usually gives the memory back.`, evidence, actions };
    }
    if (idle.length) {
      const top = idle.slice(0, 2);
      const held = top.reduce((n, a) => n + a.memory, 0);
      top.forEach(a => evidence.push(`${a.name}: idle ${a.idleAtLeast ? "≥ " : ""}${fmtIdle(a.idleMinutes ?? 0)}, ${fmt(a.memory)}`));
      return { tone: 'act', headline: `Memory is tight${swapping}. ${list(top.map(a => a.name))} ${top.length > 1 ? 'are' : 'is'} holding ${fmt(held)} while you aren’t using ${top.length > 1 ? 'them' : 'it'}.`, detail: 'Closing idle apps is the fastest way to make the system responsive again.', evidence, actions: top.map(closeAction) };
    }
    const busy = userApps.filter(a => a.memory >= 1024 ** 3).slice(0, 3);
    if (busy.length) busy.forEach(a => evidence.push(`${a.name}: ${fmt(a.memory)}, ${a.activeNow ? 'in use now' : a.idleMinutes != null ? `used ${fmtIdle(a.idleMinutes)} ago` : 'recently used'}`));
    return {
      tone: 'watch',
      headline: `Memory is tight${swapping}, mostly from apps you’re using${busy.length ? ` (${list(busy.map(a => a.name))})` : ''}.`,
      detail: input.watchingMinutes < 20
        ? 'MemNEX is still learning which apps you use; idle-app suggestions appear after about 20 minutes.'
        : 'Nothing is idle enough to close safely. If this happens often, this workload needs more memory than the machine has.',
      evidence, actions: [{ kind: 'review', label: 'See all apps' }],
    };
  }

  // ── 2. Not memory — but the machine still feels slow? Explain the usual suspects.
  const kernel = cpuOf(proc('kernel_task'));
  if (kernel > 100) {
    evidence.push(`kernel_task: ${Math.round(kernel)}% CPU`);
    return { tone: 'watch', headline: 'macOS is slowing the CPU down to keep the Mac cool.', detail: 'kernel_task reserves CPU time when the machine is hot. Improve airflow or close heavy apps; this isn’t a memory problem.', evidence, actions: [] };
  }
  const spotlight = cpuOf([...proc('mds_stores'), ...proc('mds'), ...processes.filter(p => p.name.toLowerCase().startsWith('mdworker'))]);
  if (spotlight > 60) {
    evidence.push(`Spotlight: ${Math.round(spotlight)}% CPU`);
    return { tone: 'watch', headline: 'Spotlight is indexing your files.', detail: 'This is temporary — common after updates or copying many files — and settles on its own.', evidence, actions: [] };
  }
  if (input.cpuUsage > 80) {
    const hog = [...apps].filter(a => a.kind !== 'system').sort((a, b) => b.cpu - a.cpu)[0];
    if (hog && hog.cpu / input.cores > 25) {
      evidence.push(`CPU: ${Math.round(input.cpuUsage)}% overall`, `${hog.name}: ${Math.round(hog.cpu)}% of one core`);
      const canAct = hog.kind === 'app' && hog.status === 'Normal' && !hog.activeNow;
      return { tone: 'watch', headline: `${hog.name} is keeping the processor busy.`, detail: hog.activeNow ? 'It’s the app you’re using, so this is probably expected work.' : 'It’s working in the background.', evidence, actions: canAct ? [closeAction(hog)] : [] };
    }
  }

  // ── 3. Healthy — but warn early, before it becomes a problem.
  if (growing) {
    const where = growthLine(growing);
    return { tone: 'watch', headline: `All good for now, but ${growing.name} keeps growing (+${fmt(growing.growth!.bytes)} in ${growing.growth!.minutes} min).`, detail: `If it continues, it will start to slow things down${where}.`, evidence, actions: [restartAction(growing)] };
  }
  const optional = idle.filter(a => a.suggested);
  return {
    tone: 'ok',
    headline: 'Everything is running smoothly.',
    detail: optional.length
      ? `No action needed. ${list(optional.slice(0, 2).map(a => a.name))} ${optional.length > 1 ? 'haven’t' : 'hasn’t'} been used for a while, if you want to tidy up.`
      : 'No action needed.',
    evidence,
    actions: [],
  };
}
