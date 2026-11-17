import { basename } from 'node:path';
import type { DuplicateGroup } from '../types';
import type { CleanupCandidate, CleanupRisk, DockerStorage, LargeFile, LocationAnalysis, ProjectActivity, RepositoryStorage, SharedCache, WorktreeStorage } from '../storage-types';
import { isInside } from '../privacy-engine';
import { typeOf } from '../index-engine';
import { ago, artifactEntry, dedupeByPath, entryId, labelEntry, type GitStates } from '../dev-storage-engine';
import { riskOrder } from './classify';

/**
 * Cleanup intelligence: review opportunities, never actions. FileNEX has no delete operation — the preview lists exact
 * paths so the user can decide and act in Finder / Explorer / their package manager themselves.
 */

const DAY = 86_400_000;
const DISPOSABLE_EXT = /^(zip|dmg|iso|pkg|mpkg|tar|gz|tgz|bz2|xz|7z|rar|msi|exe|img|vmdk|vdi|qcow2|ova|apk|ipa|whl|jar)$/i;

/** Large Files classification: your documents, photos and videos are protected; archives and installers are reviewable. */
export function largeFileRisk(f: Pick<LargeFile, 'extension' | 'inDownloads'>): { risk: CleanupRisk; reason: string } {
  if (DISPOSABLE_EXT.test(f.extension)) return { risk: 'REVIEW_CAREFULLY', reason: 'Archive, installer or disk image — often kept after use.' };
  const t = typeOf(f.extension);
  if (t === 'other') return { risk: 'REVIEW_CAREFULLY', reason: f.inDownloads ? 'In Downloads.' : 'Unrecognised file type.' };
  return { risk: 'PROTECTED', reason: 'Your document, media or project file — never suggested for cleanup.' };
}

export type CandidateInput = {
  repos: RepositoryStorage[];
  analyses: LocationAnalysis[];
  projects: Pick<ProjectActivity, 'id' | 'name' | 'path'>[];
  /** Git worktrees in approved folders: a clean one is one review item (its node_modules etc. are inside it). */
  worktrees?: WorktreeStorage[];
  duplicates: DuplicateGroup[];
  docker: DockerStorage | null;
  shared: SharedCache[];
  /** Files WorkNEX saw in use in the last day — anything containing them is never counted as recoverable. */
  recentPaths: string[];
  gitStates?: GitStates;
  now: number;
  downloadsOldDays?: number;
  largeOldDays?: number;
};

export function buildCandidates(i: CandidateInput): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  const now = i.now;
  const worktrees = i.worktrees ?? [];

  // 0. Git worktrees without uncommitted changes — one row each, named by branch. Removing a worktree keeps its branch
  //    and commits; one with uncommitted (or unknown) changes is never suggested, its folders are listed individually.
  const grouped = worktrees.filter(w => w.uncommitted === 0);
  for (const w of grouped) {
    out.push({
      id: entryId('worktree', w.path), path: w.path, name: w.folder, label: w.name,
      detail: `${w.projectName ? `${w.projectName} · ` : ''}worktree ${w.folder}${w.lastCommitSubject ? ` · last commit ${ago(w.lastCommitAt, now)}: ${w.lastCommitSubject}` : ''}`,
      type: 'worktree', group: 'worktrees', bytes: w.totalBytes, risk: 'REVIEW_CAREFULLY', regeneratable: false, recoverable: !w.inUse,
      reason: w.inUse ? `No uncommitted changes, but active ${ago(w.lastActiveAt, now)} — an agent or you may still be using it.` : `No uncommitted changes · idle since ${ago(w.lastActiveAt, now)}. Removing the worktree keeps branch ${w.branch ?? '(detached)'} and its commits.`,
      explanation: `A separate checkout of ${w.projectName ?? 'a repository'} (source + its own node_modules / build output: ${Math.round(w.dependencyBytes / 1024 ** 2)} MB dependencies).`,
      regenerate: `git worktree remove "${w.path}"`, projectId: w.projectId, projectName: w.projectName, lastUsedAt: w.lastActiveAt, container: true,
    });
  }
  const inGrouped = (p: string) => grouped.some(w => isInside(p, w.path));
  const groupOf = (t: string): CleanupCandidate['group'] => (t === 'dependencies' ? 'dependencies' : t === 'build' ? 'build' : t === 'cache' ? 'cache' : 'logs');

  // 1. Developer artifacts of DevNEX projects (risk already reflects activity, running services and Git context).
  for (const r of i.repos.filter(x => x.available)) {
    for (const e of r.breakdown) if (e.risk !== 'PROTECTED' && !inGrouped(e.path)) out.push({ ...e, group: groupOf(e.type) });
  }
  // 2. Developer artifacts in approved folders that DevNEX doesn't know (activity unknown → conservative).
  for (const a of i.analyses) {
    for (const art of a.artifacts) {
      if (art.category === 'git' || inGrouped(art.path) || i.projects.some(p => isInside(art.path, p.path))) continue;
      const e = artifactEntry(art, null, { active: false, runningServices: 0, git: i.gitStates, now, unknownActivity: true });
      if (e.risk !== 'PROTECTED') out.push({ ...e, group: groupOf(e.type) });
    }
    for (const l of a.logs) {
      if (l.bytes < 10 * 1024 ** 2 || inGrouped(l.dir) || i.projects.some(p => isInside(l.dir, p.path)) || a.artifacts.some(x => isInside(l.dir, x.path))) continue;
      const old = !!l.newestAt && now - Date.parse(l.newestAt) > 7 * DAY;
      out.push({ id: entryId('logs', l.dir), path: l.dir, name: `${l.files} log file${l.files === 1 ? '' : 's'}`, type: 'logs', group: 'logs', bytes: l.bytes, risk: old ? 'SAFE_TO_REVIEW' : 'REVIEW_CAREFULLY', regeneratable: false, recoverable: old, reason: old ? `Logs, last written ${Math.floor((now - Date.parse(l.newestAt!)) / DAY)} days ago.` : 'Recent logs — may be needed.', explanation: '*.log files in this folder.', lastUsedAt: l.newestAt });
    }
    // 3. Old downloads.
    for (const d of a.downloads) {
      const age = (now - Date.parse(d.modifiedAt)) / DAY;
      if (age < (i.downloadsOldDays ?? 90) || d.bytes < 10 * 1024 ** 2) continue;
      out.push({ id: entryId('download', d.path), path: d.path, name: d.name, type: 'download', group: 'downloads', bytes: d.bytes, risk: 'REVIEW_CAREFULLY', regeneratable: false, recoverable: true, reason: `In Downloads, not changed for ${Math.floor(age)} days.`, explanation: 'Downloaded items are often kept after use. Check you still have what you need.', lastUsedAt: d.modifiedAt, container: d.isDir });
    }
    // 4. Large, old archives / installers / disk images (documents and media are protected).
    for (const f of a.largeFiles) {
      const age = (now - Date.parse(f.modifiedAt)) / DAY;
      if (f.inDownloads || age < (i.largeOldDays ?? 180) || largeFileRisk(f).risk === 'PROTECTED' || !DISPOSABLE_EXT.test(f.extension)) continue;
      out.push({ id: entryId('large-file', f.path), path: f.path, name: f.name, type: 'large-file', group: 'large-old', bytes: f.bytes, risk: 'REVIEW_CAREFULLY', regeneratable: false, recoverable: true, reason: `Large ${f.extension.toUpperCase()} file, not changed for ${Math.floor(age)} days.`, explanation: 'Archives, installers and disk images are often kept long after use.', lastUsedAt: f.modifiedAt });
    }
  }
  // 5. Exact duplicates (identical content): every copy except the most recently modified.
  for (const g of i.duplicates.filter(x => x.kind === 'exact' && x.files[0]?.sizeBytes >= 1024 ** 2)) {
    const keep = [...g.files].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))[0];
    for (const f of g.files.filter(x => x.id !== keep.id)) {
      out.push({ id: entryId('duplicate', f.path), path: f.path, name: f.name, type: 'duplicate', group: 'duplicates', bytes: f.sizeBytes, risk: 'REVIEW_CAREFULLY', regeneratable: false, recoverable: true, reason: `Identical content to ${keep.name} (${basename(keep.parentPath)}), which was modified more recently.`, explanation: 'Exact duplicate: same size and same content hash.', lastUsedAt: f.modifiedAt });
    }
  }
  // 6. Docker unused data (read from `docker system df`; FileNEX never runs docker prune).
  if (i.docker?.available) {
    const d = i.docker;
    if (d.images.reclaimableBytes) out.push({ id: 'docker-images', path: 'docker:images', name: 'Unused Docker images', type: 'docker', group: 'docker', bytes: d.images.reclaimableBytes, risk: 'REVIEW_CAREFULLY', regeneratable: true, recoverable: true, reason: 'Images not used by any container. Re-downloaded or rebuilt when needed.', explanation: 'Review with `docker image ls` / `docker system df -v`.', regenerate: 'docker pull / docker compose build' });
    if (d.buildCache.reclaimableBytes) out.push({ id: 'docker-build-cache', path: 'docker:build-cache', name: 'Docker build cache', type: 'docker', group: 'docker', bytes: d.buildCache.reclaimableBytes, risk: 'SAFE_TO_REVIEW', regeneratable: true, recoverable: true, reason: 'Build cache — rebuilt by the next docker build (slower first build).', explanation: 'Review with `docker builder du`.' });
    if (d.volumes.reclaimableBytes) out.push({ id: 'docker-volumes', path: 'docker:volumes', name: 'Unused Docker volumes', type: 'docker', group: 'docker', bytes: d.volumes.reclaimableBytes, risk: 'REVIEW_CAREFULLY', regeneratable: false, recoverable: false, reason: 'Volumes not attached to a container — they can hold databases. Not counted as recoverable.', explanation: 'Review with `docker volume ls` before removing anything.' });
  }
  // 7. Shared package caches (only if measured — opt-in).
  for (const s of i.shared.filter(x => x.bytes)) {
    out.push({ id: `shared-${s.id}`, path: s.path, name: s.label, type: 'shared-cache', group: 'shared-cache', bytes: s.bytes!, risk: 'REVIEW_CAREFULLY', regeneratable: true, recoverable: true, reason: 'Shared package cache — packages are downloaded again when needed.', explanation: `Clear it with the package manager (${s.clean}), not by deleting files.`, regenerate: s.clean, container: true });
  }

  // Recently used work is protected from aggressive suggestions.
  for (const c of out) {
    if (i.recentPaths.some(p => isInside(p, c.path))) {
      c.recoverable = false;
      if (c.risk === 'SAFE_TO_REVIEW') c.risk = 'REVIEW_CAREFULLY';
      c.reason = `Used today (WorkNEX). ${c.reason}`;
    }
  }
  return dedupeById(out).map(c => labelEntry(c, i.projects, worktrees)).sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || b.bytes - a.bytes);
}

const dedupeById = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map(x => [x.id, x])).values()];

export const GROUP_LABEL: Record<CleanupCandidate['group'], string> = {
  worktrees: 'Git worktrees',
  build: 'Developer build artifacts', cache: 'Developer caches', dependencies: 'Regeneratable dependencies', logs: 'Old logs',
  downloads: 'Old downloads', 'large-old': 'Large old files', duplicates: 'Duplicates', docker: 'Docker unused data', 'shared-cache': 'Shared package caches',
};

/** Conservative "potentially recoverable": recoverable candidates only, each byte once. */
export function recoverySummary(cands: CleanupCandidate[]) {
  const counted = dedupeByPath(cands.filter(c => c.recoverable));
  const groups = new Map<CleanupCandidate['group'], { group: CleanupCandidate['group']; label: string; bytes: number; count: number }>();
  for (const c of counted) {
    const g = groups.get(c.group) ?? { group: c.group, label: GROUP_LABEL[c.group], bytes: 0, count: 0 };
    g.bytes += c.bytes; g.count++;
    groups.set(c.group, g);
  }
  return { totalBytes: counted.reduce((n, c) => n + c.bytes, 0), groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes) };
}

/**
 * Cleanup preview: exactly what the selection covers. Nothing is deleted — FileNEX has no delete operation.
 * Protected or unknown ids are refused and reported, never silently included.
 */
export function cleanupPreview(cands: CleanupCandidate[], ids: string[]) {
  const byId = new Map(cands.map(c => [c.id, c]));
  const selected = [...new Set(ids)].map(id => byId.get(id)).filter((c): c is CleanupCandidate => !!c && c.risk !== 'PROTECTED');
  const unknown = [...new Set(ids)].filter(id => !byId.has(id));
  const unique = dedupeByPath(selected);
  const projects = [...new Map(selected.filter(c => c.projectId).map(c => [c.projectId!, c.projectName ?? c.projectId!])).entries()].map(([id, name]) => ({ id, name }));
  return {
    selected: selected.length,
    totalBytes: unique.reduce((n, c) => n + c.bytes, 0),
    projectsAffected: projects.length,
    projects,
    items: selected.map(c => ({ id: c.id, path: c.path, name: c.name, label: c.label ?? c.name, detail: c.detail ?? null, bytes: c.bytes, risk: c.risk, regeneratable: c.regeneratable, regenerate: c.regenerate ?? null, reason: c.reason, projectName: c.projectName ?? null, group: c.group })),
    /** Selected items inside another selected folder — their bytes are counted once. */
    overlapping: selected.length - unique.length,
    unknown,
    deletes: false as const,
    note: 'FileNEX does not delete anything. Review these exact paths, then remove what you no longer need yourself (Finder / Explorer, or the package manager / Docker commands shown).',
  };
}

/* ───────────── Export for an assistant (Markdown) ───────────── */

const fmtB = (n: number) => (n <= 0 ? '0' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const cell = (s: string | null | undefined) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const CHECKS: Record<CleanupCandidate['group'], string> = {
  worktrees: 'Run `git -C "<path>" status --porcelain` (must be empty) and check the branch is merged or pushed (`git -C "<path>" log --oneline @{u}..` or `git branch --merged <target>` in the main repo). Make sure no agent / editor is using it. Then `git worktree remove "<path>"` (keeps the branch) and `git worktree prune`. Never `rm -rf` a worktree.',
  dependencies: 'Check the project is not running (`lsof +D "<path>"` is slow — prefer `ps`/DevNEX for processes whose cwd is the project). Removing means a reinstall (`npm install` / `pnpm install`) before the next run. Ask the user per project.',
  build: 'Make sure no dev server / service of that project is running. Re-created by the project build.',
  cache: 'Regenerated automatically; safe to remove when the project is idle.',
  logs: 'Ask the user whether the logs are still needed (incidents, audits) before removing.',
  downloads: 'User files. List the contents first and ask the user item by item — never remove without explicit confirmation.',
  'large-old': 'User files (archives / installers / disk images). Ask the user before removing.',
  duplicates: 'Confirm content is identical (`shasum` both files) and ask which copy to keep.',
  docker: 'Use Docker’s own commands after showing the user `docker system df -v`. Never `docker system prune -a --volumes` without explicit confirmation of the exact scope.',
  'shared-cache': 'Use the package manager’s command (shown), not `rm`.',
};

/**
 * A self-contained Markdown report for another assistant (e.g. Claude) to continue the cleanup *with the user*.
 * It lists exact paths and states the safety rules: nothing is deleted by FileNEX, and nothing should be deleted
 * without the user's explicit confirmation per item.
 */
export function cleanupReportMarkdown(cands: CleanupCandidate[], ctx: { plan?: string | null; now: number; disk?: { label: string; freeBytes: number; totalBytes: number; status: string } | null; scope: string }) {
  const counted = recoverySummary(cands);
  const groups = new Map<CleanupCandidate['group'], CleanupCandidate[]>();
  for (const c of cands) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  const order = [...groups.entries()].sort((a, b) => b[1].reduce((n, c) => n + c.bytes, 0) - a[1].reduce((n, c) => n + c.bytes, 0));
  const L: string[] = [];
  L.push('# FileNEX cleanup report', '');
  L.push(`Generated ${new Date(ctx.now).toISOString()} by NEX Workbench › FileNEX (local, read-only analysis). Scope: ${ctx.scope}.`, '');
  if (ctx.disk) L.push(`**Disk:** ${ctx.disk.label} — ${fmtB(ctx.disk.freeBytes)} free of ${fmtB(ctx.disk.totalBytes)} (status: ${ctx.disk.status}).`, '');
  L.push(`**Items:** ${cands.length} · **total listed:** ${fmtB(cands.reduce((n, c) => n + c.bytes, 0))} · **potentially recoverable (conservative, each byte once):** ${fmtB(counted.totalBytes)}`, '');
  L.push('## Instructions for the assistant', '',
    'You are helping the user free disk space. FileNEX only analyzed and listed these items; it deleted nothing.', '',
    '1. **Never delete anything without the user’s explicit confirmation for that item (or that group).** Show the exact path and size first.',
    '2. **Only touch paths listed in this report.** Do not widen the scope (no parent folders, no globs, no `rm -rf ~/...`).',
    '3. Re-check each item right before acting — the report may be out of date (path still exists, size, nothing running, Git state).',
    '4. Prefer the tool’s own command (`git worktree remove`, `npm cache clean`, Docker commands) over `rm`. Move to Trash when the user prefers reversibility.',
    '5. Never remove source code, `.git`, `.env*`, databases, documents, photos or videos — they are deliberately not in this list.',
    '6. *Review carefully* items need a question to the user; *Safe to review* items still need the user’s OK, but are regeneratable.',
    '7. After each step, report what was removed and the free space (`df -h ~`).', '');
  if (ctx.plan) L.push(ctx.plan);
  L.push('## Summary', '', '| Group | Items | Size | Counted as recoverable |', '|---|---:|---:|---:|');
  for (const [g, items] of order) L.push(`| ${GROUP_LABEL[g]} | ${items.length} | ${fmtB(items.reduce((n, c) => n + c.bytes, 0))} | ${fmtB(counted.groups.find(x => x.group === g)?.bytes ?? 0)} |`);
  L.push('');
  for (const [g, items] of order) {
    L.push(`## ${GROUP_LABEL[g]} (${items.length} · ${fmtB(items.reduce((n, c) => n + c.bytes, 0))})`, '', `**Before acting:** ${CHECKS[g]}`, '');
    L.push('| # | Item | Size | Risk | Recoverable | Last used | Project | Why | Path | Command |', '|---:|---|---:|---|---|---|---|---|---|---|');
    items.sort((a, b) => b.bytes - a.bytes).forEach((c, i) => {
      L.push(`| ${i + 1} | ${cell(c.label ?? c.name)}${c.detail ? `<br>${cell(c.detail)}` : ''} | ${fmtB(c.bytes)} | ${c.risk} | ${c.recoverable ? 'yes' : 'no'} | ${cell(c.lastUsedAt ? c.lastUsedAt.slice(0, 10) : null)} | ${cell(c.projectName)} | ${cell(c.reason)} | \`${cell(c.path)}\` | ${c.regenerate ? `\`${cell(c.regenerate)}\`` : '—'} |`);
    });
    L.push('');
  }
  L.push('---', 'Protected by FileNEX and never listed: source code, Git history, `.env*`, databases, documents, photos, videos. Only folders the user approved in FileNEX were analyzed.');
  return L.join('\n');
}
