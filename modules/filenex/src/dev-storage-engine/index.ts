import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { FilenexSettings, WorkContextRef } from '../types';
import type { ArtifactDir, DockerStorage, LocationAnalysis, ProjectActivity, RepoStorageSnapshot, RepositoryStorage, SharedCache, StorageEntry, WorktreeGit, WorktreeStorage } from '../storage-types';
import { approvedLocationFor, isInside } from '../privacy-engine';
import { assessRisk, ruleById } from '../storage-engine/classify';
import { repoGrowth } from '../storage-history';

/**
 * Dev Storage Map.
 *
 *   DevNEX knows where the repo is. FileNEX still needs explicit permission to analyze it.
 *
 * Inputs are DevNEX projects (boundaries, running services), WorkNEX contexts (recent use) and FileNEX's own analyses
 * of approved locations. A project outside the approved locations is reported as unavailable — it is never scanned.
 */

const DAY = 86_400_000;
const cmp = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
export const entryId = (type: string, path: string) => createHash('sha1').update(`${type}:${cmp(path)}`).digest('hex').slice(0, 16);
/** Docker Compose's default project name for a folder. */
export const composeName = (path: string) => basename(path).toLowerCase().replace(/[^a-z0-9_-]/g, '');

export type GitStates = Map<string, 'ignored' | 'tracked' | 'untracked' | null>;

/** "19 hours ago" / "3 days ago". */
export function ago(iso: string | null, now: number): string {
  if (!iso) return 'unknown';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 2 ? 'just now' : m < 60 ? `${m} minutes ago` : m < 48 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
}
const rel = (base: string, p: string) => relative(base, p).split(sep).join('/');

/**
 * Git worktrees found in approved folders, named by their branch. "In use" = uncommitted changes (or unknown Git state),
 * or anything changed / committed in the last 24 hours. Git is context only — it never grants or extends permission.
 */
export function buildWorktrees(analyses: LocationAnalysis[], projects: Pick<ProjectActivity, 'id' | 'name' | 'path'>[], git: Map<string, WorktreeGit | null>, now: number): WorktreeStorage[] {
  return analyses.flatMap(a => (a.worktrees ?? []).map(w => {
    const g = git.get(w.path) ?? null;
    const arts = a.artifacts.filter(x => isInside(x.path, w.path));
    const sum = (cat: string) => arts.filter(x => x.category === cat).reduce((n, x) => n + x.bytes, 0);
    const project = (g?.mainPath ? projects.find(p => cmp(p.path) === cmp(g.mainPath!)) : undefined) ?? projects.find(p => isInside(w.path, p.path));
    const lastActiveAt = [w.newestSourceAt, g?.lastCommitAt ?? null].filter((x): x is string => !!x).sort().pop() ?? null;
    const recent = !!lastActiveAt && now - Date.parse(lastActiveAt) < DAY;
    const uncommitted = g ? g.uncommitted : null;
    const inUse = uncommitted === null || uncommitted > 0 || recent;
    const folder = basename(w.path);
    return {
      path: w.path, folder, name: g?.branch || folder, branch: g?.branch ?? null, lastCommitAt: g?.lastCommitAt ?? null, lastCommitSubject: g?.lastCommitSubject ?? null,
      uncommitted, mainPath: g?.mainPath ?? null, projectId: project?.id, projectName: project?.name,
      totalBytes: w.totalBytes, dependencyBytes: sum('dependencies'), buildBytes: sum('build'), cacheBytes: sum('cache'), sourceBytes: w.sourceBytes,
      lastActiveAt, inUse,
      status: uncommitted === null ? 'Git status unknown' : uncommitted > 0 ? `${uncommitted} uncommitted change${uncommitted === 1 ? '' : 's'}` : recent ? `Clean · active ${ago(lastActiveAt, now)}` : `Clean · idle since ${ago(lastActiveAt, now)}`,
    };
  })).sort((x, y) => y.totalBytes - x.totalBytes);
}

/**
 * Readable names: "frontend/node_modules" relative to its worktree or project, with a context line
 * ("topo · worktree fix/cr-075-…"), instead of a bare "node_modules" and a truncated path.
 */
export function labelEntry<T extends StorageEntry>(e: T, projects: Pick<ProjectActivity, 'id' | 'name' | 'path'>[], worktrees: WorktreeStorage[]): T {
  if (!isAbsolute(e.path) || e.label) return e;
  const wt = worktrees.filter(w => isInside(e.path, w.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const proj = projects.filter(p => isInside(e.path, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (wt && cmp(wt.path) !== cmp(e.path)) return { ...e, label: rel(wt.path, e.path), detail: `${wt.projectName ?? proj?.name ?? 'Worktree'} · worktree ${wt.name}` };
  if (proj && cmp(proj.path) !== cmp(e.path)) return { ...e, label: rel(proj.path, e.path), detail: proj.name };
  if (e.container && e.projectName) return { ...e, label: e.name, detail: e.projectName };
  const parts = e.path.split(/[\\/]/).filter(Boolean);
  return { ...e, label: parts.slice(-2).join('/'), detail: e.projectName ?? parts.slice(-4, -2).join('/') };
}
export type DevInput = {
  projects: ProjectActivity[];
  analyses: LocationAnalysis[];
  settings: Pick<FilenexSettings, 'locations'>;
  contexts: WorkContextRef[];
  docker?: DockerStorage | null;
  repoHistory?: RepoStorageSnapshot[];
  gitStates?: GitStates;
  /** Git facts per worktree path (branch, last commit, uncommitted files). */
  worktreeGit?: Map<string, WorktreeGit | null>;
  now: number;
  /** "Active project": running services or activity within this many days. */
  activeDays?: number;
  inactiveDays: number;
  enabled?: boolean;
};

const empty = (p: ProjectActivity, reason: RepositoryStorage['unavailableReason']): RepositoryStorage => ({
  projectId: p.id, name: p.name, path: p.path, available: false, unavailableReason: reason,
  totalBytes: 0, sourceBytes: 0, dependencyBytes: 0, buildBytes: 0, cacheBytes: 0, logBytes: 0, gitBytes: 0, otherBytes: 0,
  recoverableEstimateBytes: 0, lastActiveAt: null, lastActiveSource: null, isActiveProject: p.runningServices > 0, recentlyUsed: false,
  inactiveDays: null, runningServiceCount: p.runningServices, analyzedAt: null, growth7dBytes: null, nested: false, worktrees: [], breakdown: [],
});

/** Last WorkNEX activity for a project: by project id, project path, or files it saw inside the folder. */
export function workActivity(p: Pick<ProjectActivity, 'id' | 'path'>, contexts: WorkContextRef[]) {
  const mine = contexts.filter(c => c.projectId === p.id || (c.projectPath && isInside(c.projectPath, p.path)) || c.files.some(f => f.path && isInside(f.path, p.path)));
  const last = mine.map(c => c.lastActiveAt).sort().pop() ?? null;
  return { last, active: mine.some(c => c.isActive) };
}

function artifactEntry(a: ArtifactDir, p: ProjectActivity | null, ctx: { active: boolean; runningServices: number; git?: GitStates; now: number; unknownActivity?: boolean }): StorageEntry {
  const rule = ruleById(a.rule);
  const git = ctx.git?.get(a.path) ?? null;
  const r = assessRisk(a.category, rule, { active: ctx.active, runningServices: ctx.runningServices, git, modifiedAt: a.modifiedAt, now: ctx.now });
  // A project DevNEX doesn't know: activity is unknown → never count its dependencies as recoverable.
  const recoverable = r.recoverable && !(ctx.unknownActivity && a.category === 'dependencies');
  return {
    id: entryId(a.category, a.path), path: a.path, name: a.name, type: a.category, bytes: a.bytes, risk: r.risk, regeneratable: a.regeneratable, recoverable,
    reason: ctx.unknownActivity && a.category === 'dependencies' ? 'Regeneratable, but this folder is not a DevNEX project — FileNEX can’t tell whether it is in use.' : r.reason,
    explanation: rule?.explanation ?? '', regenerate: rule?.regenerate, projectId: p?.id, projectName: p?.name ?? (a.projectRoot ? basename(a.projectRoot) : undefined),
    lastUsedAt: a.modifiedAt, runtime: a.runtime, git, container: true,
  };
}
export { artifactEntry };

/** Storage footprint of every DevNEX project. Only analyses of approved locations are ever used. */
export function buildRepositories(input: DevInput): RepositoryStorage[] {
  const { now } = input;
  const activeMs = (input.activeDays ?? 7) * DAY;
  const allWorktrees = buildWorktrees(input.analyses, input.projects, input.worktreeGit ?? new Map(), now);
  const out: RepositoryStorage[] = input.projects.map(p => {
    if (input.enabled === false) return empty(p, 'disabled');
    const loc = approvedLocationFor(p.path, input.settings, { includePaused: true });
    if (!loc) return empty(p, input.settings.locations.some(l => isInside(l.path, p.path)) ? 'partial' : 'not-approved');
    const analysis = input.analyses.find(a => a.locationId === loc.id);
    const root = analysis?.roots.find(r => cmp(r.path) === cmp(p.path));
    if (!analysis || !root) return empty(p, 'pending');

    const arts = analysis.artifacts.filter(a => isInside(a.path, p.path));
    const sum = (cat: string) => arts.filter(a => a.category === cat).reduce((n, a) => n + a.bytes, 0);
    const work = workActivity(p, input.contexts);
    const fileLast = root.newestSourceAt;
    const lastActiveAt = [work.last, fileLast].filter((x): x is string => !!x).sort().pop() ?? null;
    const lastActiveSource = !lastActiveAt ? null : lastActiveAt === work.last ? 'worknex' : 'files';
    const recentlyUsed = work.active || (!!work.last && now - Date.parse(work.last) < DAY);
    const isActive = p.runningServices > 0 || work.active || (!!lastActiveAt && now - Date.parse(lastActiveAt) < activeMs);
    const ctx = { active: isActive, runningServices: p.runningServices, git: input.gitStates, now };

    const breakdown: StorageEntry[] = arts.map(a => artifactEntry(a, p, ctx));
    // Loose *.log files inside the project (outside log folders), grouped by folder.
    for (const l of analysis.logs.filter(x => isInside(x.dir, p.path) && !arts.some(a => isInside(x.dir, a.path)))) {
      const r = assessRisk('logs', ruleById('logs'), { active: isActive, runningServices: p.runningServices, now, git: input.gitStates?.get(l.dir) ?? null, modifiedAt: l.newestAt });
      breakdown.push({ id: entryId('logs', l.dir), path: l.dir, name: `${l.files} log file${l.files === 1 ? '' : 's'}`, type: 'logs', bytes: l.bytes, risk: r.risk, regeneratable: false, recoverable: r.recoverable, reason: r.reason, explanation: '*.log files in this folder.', projectId: p.id, projectName: p.name, lastUsedAt: l.newestAt });
    }
    breakdown.push({ id: entryId('source', p.path), path: p.path, name: 'Source & configuration', type: 'source', bytes: root.sourceBytes, risk: 'PROTECTED', regeneratable: false, recoverable: false, reason: 'Source code, configuration, docs and .env files — never suggested for cleanup.', explanation: 'Code, config, docs, lockfiles, .env and other text the project is made of.', projectId: p.id, projectName: p.name });
    if (root.otherBytes) breakdown.push({ id: entryId('other', p.path), path: p.path, name: 'Other project files', type: 'other', bytes: root.otherBytes, risk: 'PROTECTED', regeneratable: false, recoverable: false, reason: 'Files that are not known build output (assets, data, binaries…).', explanation: 'Images, media, data files and anything not classified.', projectId: p.id, projectName: p.name });

    const dockerBytes = input.docker?.available ? [...new Set([...p.composeProjects, composeName(p.path)])].reduce((n, c) => n + (input.docker!.byComposeProject[c] ?? 0), 0) : 0;
    const g = input.repoHistory ? repoGrowth(input.repoHistory.filter(r => r.projectId === p.id), now, 7) : null;
    return {
      projectId: p.id, name: p.name, path: p.path, available: true,
      totalBytes: root.totalBytes,
      sourceBytes: root.sourceBytes, otherBytes: root.otherBytes,
      dependencyBytes: sum('dependencies'), buildBytes: sum('build'), cacheBytes: sum('cache'),
      logBytes: sum('logs') + root.looseLogBytes, gitBytes: sum('git'),
      dockerRelatedBytes: dockerBytes || undefined,
      recoverableEstimateBytes: breakdown.filter(e => e.recoverable).reduce((n, e) => n + e.bytes, 0),
      lastActiveAt, lastActiveSource, isActiveProject: isActive, recentlyUsed,
      inactiveDays: lastActiveAt ? Math.floor((now - Date.parse(lastActiveAt)) / DAY) : null,
      runningServiceCount: p.runningServices, analyzedAt: analysis.analyzedAt, growth7dBytes: g?.deltaBytes ?? null, nested: false,
      worktrees: allWorktrees.filter(w => w.projectId === p.id),
      breakdown: breakdown.map(e => labelEntry(e, input.projects, allWorktrees)).sort((a, b) => b.bytes - a.bytes),
    };
  });
  // A project inside another listed project is already part of the parent's total.
  for (const r of out) r.nested = r.available && out.some(o => o !== r && o.available && cmp(o.path) !== cmp(r.path) && isInside(r.path, o.path));
  return out;
}

/**
 * Keep each byte once. Container entries (a whole folder: node_modules, a download folder…) absorb any entry inside
 * them; non-folder entries (Docker, shared caches) have pseudo paths and are never nested.
 */
export function dedupeByPath<T extends { id: string; path: string; container?: boolean }>(xs: T[]): T[] {
  const real = (p: string) => isAbsolute(p);
  const containers: T[] = [];
  for (const c of xs.filter(x => x.container && real(x.path)).sort((a, b) => a.path.length - b.path.length)) {
    if (!containers.some(k => isInside(c.path, k.path))) containers.push(c);
  }
  const out = new Map<string, T>(containers.map(c => [c.id, c]));
  for (const x of xs) {
    if (x.container && real(x.path)) continue;
    if (real(x.path) && containers.some(k => isInside(x.path, k.path))) continue;
    if (!out.has(x.id)) out.set(x.id, x);
  }
  return [...out.values()];
}

export type DevSort = 'largest' | 'recoverable' | 'oldest-active' | 'dependencies' | 'build-cache' | 'growth';
export function sortRepos(repos: RepositoryStorage[], by: DevSort): RepositoryStorage[] {
  const key: Record<DevSort, (r: RepositoryStorage) => number> = {
    largest: r => r.totalBytes, recoverable: r => r.recoverableEstimateBytes, dependencies: r => r.dependencyBytes,
    'build-cache': r => r.buildBytes + r.cacheBytes, growth: r => r.growth7dBytes ?? -Infinity,
    'oldest-active': r => (r.lastActiveAt ? -Date.parse(r.lastActiveAt) : Infinity),
  };
  return [...repos].sort((a, b) => Number(b.available) - Number(a.available) || key[by](b) - key[by](a));
}

/**
 * Developer storage search: a name ("SmartFlowNEX") or simple size filters ("node_modules > 5GB", "build >= 500mb",
 * "total < 1gb"). Several filters can be combined with spaces. Deterministic — no LLM.
 */
export function filterRepos(repos: RepositoryStorage[], q: string): RepositoryStorage[] {
  const query = q.trim();
  if (!query) return repos;
  const FIELDS: Record<string, (r: RepositoryStorage) => number> = {
    node_modules: r => r.dependencyBytes, dependencies: r => r.dependencyBytes, deps: r => r.dependencyBytes,
    build: r => r.buildBytes, dist: r => r.buildBytes, '.next': r => r.buildBytes, cache: r => r.cacheBytes,
    logs: r => r.logBytes, log: r => r.logBytes, git: r => r.gitBytes, '.git': r => r.gitBytes, source: r => r.sourceBytes, src: r => r.sourceBytes,
    total: r => r.totalBytes, size: r => r.totalBytes, recoverable: r => r.recoverableEstimateBytes, docker: r => r.dockerRelatedBytes ?? 0,
  };
  const UNIT: Record<string, number> = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 };
  const conds: ((r: RepositoryStorage) => boolean)[] = [];
  const rest = query.replace(/([\w.\-]+)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|t|g|m|k|b)?/gi, (_m, f: string, op: string, n: string, u?: string) => {
    const get = FIELDS[f.toLowerCase()];
    if (!get) return _m;
    const v = Number(n) * UNIT[(u ?? 'gb').toLowerCase()];
    conds.push(r => (op === '>' ? get(r) > v : op === '>=' ? get(r) >= v : op === '<' ? get(r) < v : get(r) <= v));
    return ' ';
  }).trim().toLowerCase();
  return repos.filter(r => conds.every(c => c(r)) && (!rest || rest.split(/\s+/).every(w => r.name.toLowerCase().includes(w) || r.path.toLowerCase().includes(w))));
}

/** Totals without double counting: nested projects are inside their parent; shared stores are never added to repos. */
export function devSummary(repos: RepositoryStorage[], shared: SharedCache[]) {
  const avail = repos.filter(r => r.available);
  const top = avail.filter(r => !r.nested);
  const entries = dedupeByPath(avail.flatMap(r => r.breakdown));
  const recoverable = entries.filter(e => e.recoverable);
  const byRule = new Map<string, { label: string; bytes: number; repos: { projectId: string; name: string; bytes: number }[] }>();
  const labelFor = (e: StorageEntry) => (e.type === 'dependencies' ? (e.name === 'node_modules' ? 'node_modules' : e.name) : e.type === 'build' ? (e.name === '.next' ? '.next' : ['dist', 'build', 'out'].includes(e.name) ? 'dist / build / out' : e.name) : e.type === 'cache' ? (e.name === '.turbo' ? 'Turbo cache' : e.name === 'coverage' ? 'Coverage' : e.name) : e.name);
  for (const e of entries.filter(x => ['dependencies', 'build', 'cache'].includes(x.type))) {
    const label = labelFor(e);
    const g = byRule.get(`${e.type}:${label}`) ?? { label, bytes: 0, repos: [] };
    g.bytes += e.bytes;
    const owner = g.repos.find(x => x.projectId === e.projectId);
    if (owner) owner.bytes += e.bytes; else g.repos.push({ projectId: e.projectId ?? '', name: e.projectName ?? '', bytes: e.bytes });
    byRule.set(`${e.type}:${label}`, g);
  }
  const group = (type: string) => [...byRule.entries()].filter(([k]) => k.startsWith(`${type}:`)).map(([, v]) => ({ ...v, repos: v.repos.sort((a, b) => b.bytes - a.bytes) })).sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes: top.reduce((n, r) => n + r.totalBytes, 0),
    repositories: avail.length,
    unavailable: repos.length - avail.length,
    recoverableBytes: recoverable.reduce((n, e) => n + e.bytes, 0),
    dependencies: { totalBytes: top.reduce((n, r) => n + r.dependencyBytes, 0), groups: group('dependencies') },
    buildCache: { totalBytes: entries.filter(e => e.type === 'build' || e.type === 'cache').reduce((n, e) => n + e.bytes, 0), groups: [...group('build'), ...group('cache')].sort((a, b) => b.bytes - a.bytes) },
    gitBytes: top.reduce((n, r) => n + r.gitBytes, 0),
    /** Shown separately and never added to repository totals (pnpm node_modules may hard-link into the store). */
    shared: shared.map(s => ({ id: s.id, label: s.label, path: s.path, bytes: s.bytes, measuredAt: s.measuredAt, clean: s.clean, insideApprovedLocation: s.insideApprovedLocation })),
  };
}
