import { relative, sep } from 'node:path';
import type { IndexedLocation } from '../types';
import type { CleanupCandidate, CleanupPlan, PlanItem, PlanStep, StorageHealth, WorktreeStorage } from '../storage-types';
import { approvedLocationFor, isInside } from '../privacy-engine';
import { ago, dedupeByPath } from '../dev-storage-engine';

const DAY = 86_400_000, GB = 1024 ** 3, MB = 1024 ** 2;
const fmt = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MB))} MB`);
const sumOnce = (cs: { id: string; path: string; bytes: number; container?: boolean }[]) => dedupeByPath(cs).reduce((n, c) => n + c.bytes, 0);
const monthYear = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export type PlanInput = {
  candidates: CleanupCandidate[];
  worktrees: WorktreeStorage[];
  locations: Pick<IndexedLocation, 'id' | 'path' | 'label' | 'paused'>[];
  disk: { freeBytes: number; totalBytes: number; status: StorageHealth } | null;
  now: number;
  /** Dependencies unchanged for this long count as "not touched in a while". */
  idleDays?: number;
  top?: number;
};

/**
 * Suggested cleanup plan — deterministic rules, no AI:
 *   1. Build output (regeneratable, most space, least risk) — skipping projects whose services are running.
 *   2. Dependencies of projects not touched in a while — keeping projects in use; noting the same project installed twice.
 *   3. Check first — worktrees (by Git state), big logs, old archives.
 *   4. Your call — personal downloads, duplicates, small caches, Docker, shared caches.
 */
export function buildCleanupPlan(i: PlanInput): CleanupPlan {
  const { now } = i;
  const top = i.top ?? 6;
  const idleMs = (i.idleDays ?? 60) * DAY;
  /** "AppSightNEX-azure/web/.next" — relative to the approved folder it is in. */
  const name = (c: { path: string; label?: string }) => {
    if (c.path.startsWith('docker:')) return c.label ?? c.path;
    const loc = approvedLocationFor(c.path, { locations: i.locations as IndexedLocation[] }, { includePaused: true });
    return loc ? relative(loc.path, c.path).split(sep).join('/') || loc.label : c.label ?? c.path;
  };
  /** A project's readable name: its own name, or its folder path when the name is generic (frontend, api, web…). */
  const GENERIC = /^(frontend|backend|web|api|app|apps|client|server|ui|site|www|src|packages?|services?|main|default project)$/i;
  const projectLabel = (c: CleanupCandidate) => {
    const folder = name({ path: c.path.replace(/[\\/][^\\/]+$/, '') });
    return c.projectName && !GENERIC.test(c.projectName) ? c.projectName : folder;
  };
  const item = (c: CleanupCandidate, note?: string): PlanItem => ({ id: c.id, label: name(c), path: c.path, bytes: c.bytes, note });
  const steps: PlanStep[] = [];
  const inWorktree = (p: string) => i.worktrees.some(w => isInside(p, w.path));
  const busyWorktree = (p: string) => i.worktrees.find(w => w.inUse && isInside(p, w.path));

  // 1 · Build output — regeneratable.
  const builds = i.candidates.filter(c => c.group === 'build');
  const buildOk = builds.filter(c => c.risk === 'SAFE_TO_REVIEW' && c.recoverable && !busyWorktree(c.path)).sort((a, b) => b.bytes - a.bytes);
  const running = [...new Set(builds.filter(c => /running services/.test(c.reason)).map(projectLabel))];
  const busyWt = [...new Set(builds.map(c => busyWorktree(c.path)).filter((w): w is WorktreeStorage => !!w).map(w => `${w.projectName ? `${w.projectName} ` : ''}worktree ${w.name}`))];
  if (buildOk.length) {
    steps.push({
      key: 'build', title: 'Build output — most space, least risk', bytes: sumOnce(buildOk),
      why: 'Re-created by building the project. Removing it only makes the next build take a little longer.',
      items: buildOk.slice(0, top).map(c => item(c)), more: Math.max(0, buildOk.length - top),
      keep: [...running.map(p => ({ label: p, reason: 'its services are running — a service may be using the build output' })), ...busyWt.map(w => ({ label: w, reason: 'still in use (see step 3)' }))],
      notes: [], ids: buildOk.map(c => c.id),
    });
  }

  // 2 · Dependencies of projects not touched in a while.
  const deps = i.candidates.filter(c => c.group === 'dependencies' && !inWorktree(c.path));
  const idle = deps.filter(c => c.lastUsedAt && now - Date.parse(c.lastUsedAt) >= idleMs && !/project is active/.test(c.reason) && !/Used today/.test(c.reason)).sort((a, b) => b.bytes - a.bytes);
  const keepDeps = [...new Set(deps.filter(c => !idle.includes(c)).map(projectLabel))];
  if (idle.length) {
    const byProject = new Map<string, CleanupCandidate[]>();
    for (const c of idle) { const k = c.projectName && !GENERIC.test(c.projectName) ? c.projectName.toLowerCase() : ''; if (k) byProject.set(k, [...(byProject.get(k) ?? []), c]); }
    const twice = [...byProject.values()].filter(cs => cs.length > 1).sort((a, b) => sumOnce(b) - sumOnce(a));
    const newest = idle.map(c => c.lastUsedAt!).sort().pop()!;
    steps.push({
      key: 'idle-deps', title: 'node_modules of projects not touched in a while', bytes: sumOnce(idle),
      why: `Not changed for at least ${Math.round(idleMs / DAY)} days (most recent: ${monthYear(newest)}). If you come back to a project, reinstall with npm install.`,
      items: idle.slice(0, top).map(c => item(c, c.lastUsedAt ? `not changed since ${monthYear(c.lastUsedAt)}` : undefined)), more: Math.max(0, idle.length - top),
      keep: keepDeps.slice(0, 8).map(p => ({ label: p, reason: 'used recently' })),
      notes: twice.slice(0, 4).map(cs => `${cs[0].projectName} is installed in ${cs.length} places (${cs.map(c => name(c).replace(/\/node_modules$/, '')).join(', ')}) — ${fmt(sumOnce(cs))} together.`),
      ids: idle.map(c => c.id),
    });
  }

  // 3 · Check first.
  const check: PlanItem[] = [];
  const checkNotes: string[] = [];
  for (const w of i.worktrees.sort((a, b) => b.totalBytes - a.totalBytes)) {
    const label = `${w.projectName ? `${w.projectName} worktree ` : 'Worktree '}${w.name}`;
    if (w.uncommitted) check.push({ id: null, label, path: w.path, bytes: w.totalBytes, note: `${w.uncommitted} uncommitted change${w.uncommitted > 1 ? 's' : ''} — when its work is finished and merged, remove the whole worktree with git worktree remove instead of deleting folders inside it` });
    else if (w.inUse) check.push({ id: null, label, path: w.path, bytes: w.totalBytes, note: `last activity ${ago(w.lastActiveAt, now)} — still in use, don’t remove yet` });
    else { const c = i.candidates.find(x => x.group === 'worktrees' && x.path === w.path); check.push({ id: c?.id ?? null, label, path: w.path, bytes: w.totalBytes, note: `clean, idle since ${ago(w.lastActiveAt, now)} — check the branch is merged or pushed, then git worktree remove` }); }
  }
  for (const c of i.candidates.filter(x => x.group === 'logs' && x.bytes >= 50 * MB).sort((a, b) => b.bytes - a.bytes).slice(0, 3)) check.push({ ...item(c, 'remove if you don’t need them to investigate an incident'), label: /log files?$/.test(c.name) ? `${name(c)} (${c.name})` : name(c) });
  for (const c of i.candidates.filter(x => x.group === 'large-old').sort((a, b) => b.bytes - a.bytes).slice(0, 3)) check.push(item(c, `old ${c.path.split('.').pop()?.toUpperCase()} file — often a backup or installer kept after use`));
  if (check.length) steps.push({
    key: 'check-first', title: 'Check first whether it’s still in use', bytes: check.reduce((n, x) => n + x.bytes, 0),
    why: 'These may still be needed. Look before you remove anything.', items: check, more: 0, keep: [], notes: checkNotes, ids: [],
  });

  // 4 · Your call.
  const callItems: PlanItem[] = [];
  const callNotes: string[] = [];
  const downloads = i.candidates.filter(c => c.group === 'downloads').sort((a, b) => b.bytes - a.bytes);
  if (downloads.length) {
    callItems.push({ id: null, label: `Old downloads (${downloads.length})`, path: '', bytes: sumOnce(downloads), note: 'your own files — choose item by item' });
    callNotes.push(`Largest downloads: ${downloads.slice(0, 5).map(c => `${c.name} ${fmt(c.bytes)}`).join(', ')}.`);
  }
  const dups = i.candidates.filter(c => c.group === 'duplicates');
  if (dups.length) { const b = sumOnce(dups); callItems.push({ id: null, label: `Duplicates (${dups.length} files)`, path: '', bytes: b, note: b < 2 * GB ? 'each pair needs checking — a lot of effort for the space you get back' : 'check each pair, keep the copy you use' }); }
  const caches = i.candidates.filter(c => c.group === 'cache');
  if (caches.length) { const b = sumOnce(caches); callItems.push({ id: null, label: `Caches (${caches.length})`, path: '', bytes: b, note: b < 500 * MB ? 'very little space — fine to leave' : 'rebuilt automatically — safe to remove when projects are idle' }); }
  const docker = i.candidates.filter(c => c.group === 'docker');
  if (docker.length) callItems.push({ id: null, label: 'Docker unused data', path: '', bytes: sumOnce(docker), note: 'review with docker system df -v; never prune volumes without checking' });
  const shared = i.candidates.filter(c => c.group === 'shared-cache');
  if (shared.length) callItems.push({ id: null, label: 'Shared package caches', path: '', bytes: sumOnce(shared), note: `clear with the package manager (${shared.map(c => c.regenerate).filter(Boolean).join(' · ')})` });
  if (callItems.length) steps.push({ key: 'your-call', title: 'Your call', bytes: callItems.reduce((n, x) => n + x.bytes, 0), why: 'Personal files or small gains — FileNEX leaves these to you.', items: callItems, more: 0, keep: [], notes: callNotes, ids: [] });

  const d = i.disk;
  const urgency: CleanupPlan['urgency'] = !d ? 'none' : d.status === 'critical' || d.status === 'low' ? 'now' : d.status === 'attention' ? 'soon' : 'none';
  const state = !d ? '' : `${fmt(d.freeBytes)} free of ${fmt(d.totalBytes)} — ${urgency === 'now' ? 'low on space: start with step 1' : urgency === 'soon' ? 'worth freeing some space soon' : 'that’s fine, no rush'}.`;
  const headline = `Read-only analysis — nothing has been deleted. ${state}${steps.length ? ' If you want space back, this order gives the most for the least risk.' : ' Nothing worth cleaning up right now.'}`.trim();
  return { generatedAt: new Date(now).toISOString(), headline, urgency, steps };
}

/** The plan as Markdown (top of the exported report). */
export function planMarkdown(p: CleanupPlan): string {
  const L = ['## Suggested plan', '', p.headline, ''];
  p.steps.forEach((s, n) => {
    L.push(`### ${n + 1}. ${s.title} (~${fmt(s.bytes)})`, '', s.why, '');
    for (const it of s.items) L.push(`- ${it.label}${it.bytes ? `: ${fmt(it.bytes)}` : ''}${it.note ? ` — ${it.note}` : ''}`);
    if (s.more) L.push(`- …and ${s.more} more`);
    for (const note of s.notes) L.push(`- ${note}`);
    if (s.keep.length) L.push('', `Leave out: ${s.keep.map(k => `${k.label} (${k.reason})`).join('; ')}.`);
    L.push('');
  });
  return L.join('\n');
}
