import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FilenexEngine } from '../engine';
import { StorageEngine, cleanupReportMarkdown, analyzeLocation, assessRisk, classifyDir, ruleById, parseDockerSize, parseSystemDf, largeFileRisk } from '../storage-engine';
import { storageForecast, storageGrowth } from '../storage-history';
import { storageHealth, DEFAULT_THRESHOLDS } from '../disk-analyzer';
import { buildRepositories, devSummary, filterRepos } from '../dev-storage-engine';
import type { DockerStorage, LocationAnalysis, ProjectActivity, RepositoryStorage, StorageSnapshot, WorktreeGit } from '../storage-types';
import type { WorkContextRef } from '../types';

// Temp tree inside the git-ignored dist folder (the system temp dir lives under /var, which FileNEX refuses as a location).
const root = mkdtempSync(join(__dirname, 'tmp-storage-'));
after(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000, GB = 1024 ** 3, MB = 1024 ** 2;
const NOW = Date.now();
function file(path: string, bytes = 10, ageMs = 0) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const t = new Date(NOW - ageMs);
  utimesSync(path, t, t);
  return path;
}
/** Big files without writing gigabytes: sparse files, measured by apparent size in tests. */
function sparse(path: string, bytes: number, ageMs = 0) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, bytes);
  const t = new Date(NOW - ageMs);
  utimesSync(path, t, t);
  return path;
}
const age = (path: string, ageMs: number) => { const t = new Date(NOW - ageMs); utimesSync(path, t, t); };

const dockerOff = async (): Promise<DockerStorage> => ({ available: false, detail: 'Docker is not running.', images: { bytes: 0, reclaimableBytes: 0, count: 0 }, containers: { bytes: 0, reclaimableBytes: 0, count: 0 }, volumes: { bytes: 0, reclaimableBytes: 0, count: 0 }, buildCache: { bytes: 0, reclaimableBytes: 0, count: 0 }, byComposeProject: {}, checkedAt: new Date().toISOString() });

let n = 0;
function makeEngine(opts: { worktree?: (path: string) => WorktreeGit | null; projects?: (home: string) => ProjectActivity[]; contexts?: (home: string) => WorkContextRef[]; git?: (path: string) => 'ignored' | 'tracked' | 'untracked' | null; free?: number; docker?: () => Promise<DockerStorage> } = {}) {
  const home = join(root, `h${++n}`);
  mkdirSync(home, { recursive: true });
  const opened: string[] = [];
  const trashed: string[] = [];
  const ran: string[] = [];
  const engine = new FilenexEngine({
    platform: {
      openPath: async p => { opened.push(`open:${p}`); }, revealPath: async p => { opened.push(`reveal:${p}`); },
      openUrl: async () => {}, openWith: async () => {}, openTerminal: async () => {}, launch: async () => {},
    },
    dataDir: join(home, '.filenex-data'), home, background: false,
    sources: {
      contexts: async () => opts.contexts?.(home) ?? [],
      projects: async () => (opts.projects?.(home) ?? []).map(p => ({ id: p.id, name: p.name, path: p.path })),
      projectActivity: async () => opts.projects?.(home) ?? [],
      git: async () => ({ isRepo: true, branch: 'feature/versioning', changed: 0, untracked: 0 }),
    },
    storage: {
      sizeMode: 'apparent', docker: opts.docker ?? dockerOff,
      trash: async p => { trashed.push(p); rmSync(p, { recursive: true }); }, runCommand: async (cmd, args) => { ran.push([cmd, ...args].join(' ')); if (args[2] === 'worktree') rmSync(args[4], { recursive: true }); }, gitPathState: async (_r, p) => opts.git?.(p) ?? 'ignored', worktreeGit: async p => opts.worktree?.(p) ?? null,
      statfs: async () => ({ bsize: 4096, blocks: (1000 * GB) / 4096, bavail: ((opts.free ?? 300) * GB) / 4096 }),
    },
  });
  engine.start();
  const approve = (rel: string) => engine.addLocation(join(home, rel), { confirmBroad: true });
  return { engine, home, opened, approve, trashed, ran };
}
const project = (home: string, rel: string, extra: Partial<ProjectActivity> = {}): ProjectActivity => ({ id: rel.replace(/\W/g, '-'), name: rel.split('/').pop()!, path: join(home, rel), runningServices: 0, status: 'STOPPED', composeProjects: [], ...extra });

/** A typical JS repo: source, node_modules, .next, dist, coverage, logs, .git, .env. */
function jsRepo(dir: string, opts: { ageMs?: number } = {}) {
  const a = opts.ageMs ?? 0;
  file(join(dir, 'package.json'), 100, a);
  file(join(dir, 'src/index.ts'), 2000, a);
  file(join(dir, 'README.md'), 300, a);
  file(join(dir, '.env'), 50, a);
  file(join(dir, 'node_modules/react/index.js'), 50_000, a);
  file(join(dir, 'node_modules/react/package.json'), 1000, a);
  file(join(dir, '.next/cache/webpack.pack'), 30_000, a);
  file(join(dir, 'dist/main.js'), 8000, a);
  file(join(dir, 'coverage/lcov.info'), 4000, a);
  file(join(dir, 'logs/server.log'), 6000, 30 * DAY);
  age(join(dir, 'logs'), 30 * DAY);
  file(join(dir, '.git/objects/pack/p.pack'), 20_000, a);
  file(join(dir, 'public/logo.png'), 5000, a);
  if (a) for (const d of ['node_modules', '.next', 'dist', 'coverage']) age(join(dir, d), a);
}

/* ═════════════ Critical privacy: DevNEX registration is not FileNEX consent ═════════════ */

test('privacy · a DevNEX project outside approved FileNEX folders is never scanned', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'Work/Approved'), project(h, 'Secret/OutsideRepo')] });
  jsRepo(join(home, 'Work/Approved'));
  jsRepo(join(home, 'Secret/OutsideRepo'));
  symlinkSync(join(home, 'Secret/OutsideRepo'), join(home, 'Work/link-to-outside'));
  const loc = approve('Work');
  await engine.storage.scanAll();

  const dump = JSON.stringify(engine.storage.history.analyses());
  assert.ok(!dump.includes('OutsideRepo'), 'nothing from the outside project is recorded');
  assert.ok(!dump.includes('Secret'), 'nothing outside the approved folder is recorded');
  const dev = await engine.storage.developer();
  const outside = dev.repos.find(r => r.name === 'OutsideRepo')!;
  assert.equal(outside.available, false);
  assert.equal(outside.unavailableReason, 'not-approved');
  assert.equal(outside.totalBytes, 0);
  assert.equal(dev.repos.find(r => r.name === 'Approved')!.available, true);

  // The walker itself never reads a directory outside the approved location (symlinks are not followed).
  const visited: string[] = [];
  await analyzeLocation(loc, { settings: engine.settings(), storage: engine.storage.settings(), watchRoots: [join(home, 'Secret/OutsideRepo')], downloadsDir: null, stillAllowed: () => true, throttleMs: () => 0, onVisit: d => visited.push(d), sizeMode: 'apparent' });
  assert.ok(visited.length > 3);
  assert.ok(visited.every(d => d.startsWith(join(home, 'Work'))), 'only approved folders are visited');
  // Cleanup candidates never include it either.
  assert.ok((await engine.storage.candidates()).every(c => !c.path.includes('OutsideRepo')));
});

test('privacy · no approved folders → disk overview only, nothing analyzed', async () => {
  const { engine, home } = makeEngine({ projects: h => [project(h, 'Repo')] });
  jsRepo(join(home, 'Repo'));
  await engine.storage.scanAll();
  assert.equal(engine.storage.history.analyses().length, 0);
  const o = await engine.storage.overview();
  assert.equal(o.volume?.freeBytes, 300 * GB, 'disk capacity needs no folder access');
  assert.equal(o.distribution?.items.length, 0);
  assert.equal(o.recovery.totalBytes, 0);
  assert.equal((await engine.storage.developer()).repos[0].unavailableReason, 'not-approved');
});

test('privacy · removing a folder stops analysis; delete choice removes its storage data', async () => {
  const { engine, home, approve } = makeEngine();
  file(join(home, 'Docs/a.pdf'), 1000);
  const loc = approve('Docs');
  await engine.storage.scanAll();
  assert.equal(engine.storage.currentAnalyses().length, 1);
  engine.removeLocation(loc.id, false);
  assert.equal(engine.storage.currentAnalyses().length, 0, 'not shown once the folder is no longer approved');
  const loc2 = approve('Docs');
  await engine.storage.scanAll();
  engine.removeLocation(loc2.id, true);
  assert.equal(engine.storage.history.analyses().length, 0, 'deleted on request');
  assert.ok(existsSync(join(home, 'Docs/a.pdf')), 'the file itself is untouched');
});

/* ═════════════ Size calculation & classification ═════════════ */

test('storage · folder size calculation counts every byte once (hard links once)', async () => {
  const { engine, home, approve } = makeEngine();
  file(join(home, 'Data/a.bin'), 1000);
  file(join(home, 'Data/sub/b.bin'), 2500);
  file(join(home, 'Data/sub/deeper/.hidden'), 500);
  linkSync(join(home, 'Data/a.bin'), join(home, 'Data/sub/a-hardlink.bin'));
  const loc = approve('Data');
  const a = await analyzeLocation(loc, { settings: engine.settings(), storage: engine.storage.settings(), watchRoots: [], downloadsDir: null, stillAllowed: () => true, throttleMs: () => 0, sizeMode: 'apparent' });
  assert.equal(a.totalBytes, 4000, 'hidden files count towards size; the hard link counts once');
  assert.equal(a.folders.find(f => f.name === 'sub'), undefined, 'tiny folders are not listed');
  assert.equal(a.aborted, false);
});

test('storage · category classification (generic names need a project)', () => {
  assert.equal(classifyDir('node_modules', [])?.category, 'dependencies');
  assert.equal(classifyDir('.git', [])?.category, 'git');
  assert.equal(classifyDir('.next', [])?.category, 'build');
  assert.equal(classifyDir('.turbo', [])?.category, 'cache');
  assert.equal(classifyDir('dist', []), null, 'a “dist” folder outside a project is not assumed to be build output');
  assert.equal(classifyDir('build', ['node'])?.category, 'build');
  assert.equal(classifyDir('coverage', ['node'])?.category, 'cache');
  assert.equal(classifyDir('bin', ['node']), null, 'bin in a Node project may be source');
  assert.equal(classifyDir('bin', ['dotnet'])?.category, 'build');
  assert.equal(classifyDir('target', ['rust'])?.category, 'build');
  assert.equal(classifyDir('.venv', ['python'])?.category, 'dependencies');
  assert.equal(classifyDir('src', ['node']), null);
  assert.equal(classifyDir('node_modules', [], { detectDependencies: false, detectBuildArtifacts: true }), null, 'detection can be turned off');
});

test('storage · node_modules and build artifacts detected; repo totals add up exactly', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'Code/shop')] });
  jsRepo(join(home, 'Code/shop'));
  file(join(home, 'Code/notes/build/plan.docx'), 777); // "build" outside a project: user data, not an artifact
  approve('Code');
  await engine.storage.scanAll();
  const a = engine.storage.currentAnalyses()[0];
  const rules = a.artifacts.map(x => x.rule).sort();
  assert.deepEqual(rules, ['coverage', 'dist', 'git', 'logs', 'next', 'node_modules']);
  assert.ok(!a.artifacts.some(x => x.path.includes('notes')));

  const repo = (await engine.storage.developer()).repos.find(r => r.name === 'shop')!;
  assert.equal(repo.dependencyBytes, 51_000);
  assert.equal(repo.buildBytes, 30_000 + 8000);
  assert.equal(repo.cacheBytes, 4000);
  assert.equal(repo.logBytes, 6000);
  assert.equal(repo.gitBytes, 20_000);
  assert.equal(repo.sourceBytes, 100 + 2000 + 300 + 50);
  assert.equal(repo.otherBytes, 5000);
  assert.equal(repo.totalBytes, repo.sourceBytes + repo.dependencyBytes + repo.buildBytes + repo.cacheBytes + repo.logBytes + repo.gitBytes + repo.otherBytes, 'no byte is lost or counted twice');
  assert.equal(a.totalBytes, repo.totalBytes + 777);
});

test('storage · incremental: unchanged developer folders are reused, not re-walked', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'P/app')] });
  jsRepo(join(home, 'P/app'));
  const loc = approve('P');
  await engine.storage.scanAll();
  const first = engine.storage.currentAnalyses()[0];
  const visited: string[] = [];
  const second = await analyzeLocation(loc, { settings: engine.settings(), storage: engine.storage.settings(), watchRoots: [join(home, 'P/app')], downloadsDir: null, previous: first, stillAllowed: () => true, throttleMs: () => 0, onVisit: d => visited.push(d), sizeMode: 'apparent' });
  assert.equal(second.totalBytes, first.totalBytes);
  assert.ok(!visited.some(d => d.includes('node_modules')), 'node_modules was not walked again');
});

/* ═════════════ Shared caches & double counting ═════════════ */

test('storage · shared package cache is separate and never added to repositories or counted twice', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'repo')] });
  jsRepo(join(home, 'repo'));
  file(join(home, '.npm/_cacache/content-v2/sha512/aa'), 70_000);
  approve('.'); // the whole (test) home — broad, confirmed
  engine.storage.updateSettings({ sharedCaches: true });
  await engine.storage.measureShared(true);
  await engine.storage.scanAll();
  const o = await engine.storage.overview();
  const loc = o.distribution!.items.find(i => i.kind === 'location')!;
  const npm = o.distribution!.items.find(i => i.key === 'shared:npm')!;
  assert.equal(npm.bytes, 70_000);
  const analyzed = engine.storage.currentAnalyses()[0].totalBytes;
  assert.equal(loc.bytes + npm.bytes, analyzed, 'the cache is moved out of its folder, not counted twice');
  const dev = await engine.storage.developer();
  assert.equal(dev.summary.totalBytes, dev.repos.find(r => r.name === 'repo')!.totalBytes, 'shared stores are not part of repository totals');
  assert.equal(dev.summary.shared.find(s => s.id === 'npm')!.bytes, 70_000);
});

test('storage · shared caches are not measured unless turned on (opt-in)', async () => {
  const { engine, home } = makeEngine();
  file(join(home, '.npm/_cacache/x'), 5000);
  await engine.storage.measureShared(true);
  assert.equal(engine.storage.sharedCaches().find(s => s.id === 'npm')!.bytes, null);
});

test('storage · nested projects are not double counted in Developer Storage totals', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'mono'), project(h, 'mono/packages/web')] });
  jsRepo(join(home, 'mono'));
  jsRepo(join(home, 'mono/packages/web'));
  approve('mono');
  await engine.storage.scanAll();
  const dev = await engine.storage.developer();
  const mono = dev.repos.find(r => r.name === 'mono')!, web = dev.repos.find(r => r.name === 'web')!;
  assert.equal(web.nested, true);
  assert.ok(mono.totalBytes > web.totalBytes);
  assert.equal(dev.summary.totalBytes, mono.totalBytes, 'the nested project is inside its parent');
  const nm = dev.summary.dependencies.groups.find(g => g.label === 'node_modules')!;
  assert.equal(nm.bytes, 2 * 51_000, 'each node_modules once');
});

/* ═════════════ Growth & forecast ═════════════ */

const snap = (daysAgo: number, usedGb: number, cats?: [string, number][]): StorageSnapshot => ({
  id: `s${daysAgo}`, timestamp: new Date(NOW - daysAgo * DAY).toISOString(), totalBytes: 1000 * GB, usedBytes: usedGb * GB, freeBytes: (1000 - usedGb) * GB,
  categories: cats?.map(([k, b]) => ({ key: k, label: k, kind: k === 'docker' ? 'docker' as const : 'location' as const, bytes: b * GB })),
});

test('storage · growth calculation attributes change and leaves the rest as “other”', () => {
  const g = storageGrowth([snap(7, 800, [['Projects', 200], ['docker', 20], ['NewFolder', 0]]), snap(3, 820), snap(0, 842.6, [['Projects', 205.1], ['docker', 38.2]])], NOW, 7)!;
  assert.ok(Math.abs(g.usedDeltaBytes - 42.6 * GB) < 1e6);
  assert.equal(g.breakdown[0].key, 'docker');
  assert.ok(Math.abs(g.breakdown[0].deltaBytes - 18.2 * GB) < 1e6);
  assert.ok(Math.abs(g.otherDeltaBytes - (42.6 - 18.2 - 5.1) * GB) < 1e6);
  assert.equal(storageGrowth([snap(0.2, 800), snap(0, 801)], NOW, 7), null, 'under a day of history: no growth claim');
});

test('storage · forecast needs enough history and is a simple linear trend', () => {
  assert.equal(storageForecast([snap(1, 800), snap(0, 801)], NOW, 1000 * GB).message, 'Not enough history to estimate.');
  // +1 GB per day for 10 days → 7 GB/week; 800 → 900 GB (90%) ≈ 100 GB away → ~14 weeks.
  const f = storageForecast(Array.from({ length: 11 }, (_, i) => snap(10 - i, 790 + i)), NOW, 1000 * GB);
  assert.equal(f.enough, true);
  assert.ok(Math.abs(f.ratePerWeekBytes! - 7 * GB) < 0.01 * GB);
  assert.ok(Math.abs(f.weeksTo90! - 100 / 7) < 0.1);
  assert.match(f.message, /90% usage in ~14 weeks/);
  assert.match(storageForecast(Array.from({ length: 6 }, (_, i) => snap(5 - i, 500)), NOW, 1000 * GB).message, /stable/);
});

test('storage · status uses size, free space, % free and trend (configurable thresholds)', () => {
  const T = DEFAULT_THRESHOLDS;
  assert.equal(storageHealth({ totalBytes: 1000 * GB, freeBytes: 188 * GB }, T).status, 'healthy');
  assert.equal(storageHealth({ totalBytes: 1000 * GB, freeBytes: 38 * GB }, T).status, 'attention');
  assert.equal(storageHealth({ totalBytes: 1000 * GB, freeBytes: 20 * GB }, T).status, 'low');
  assert.equal(storageHealth({ totalBytes: 1000 * GB, freeBytes: 6 * GB }, T).status, 'critical');
  // A small disk uses the percentage: 256 GB with 30 GB free (12%) is attention, not healthy.
  assert.equal(storageHealth({ totalBytes: 256 * GB, freeBytes: 30 * GB }, T).status, 'attention');
  // Plenty free now, but the trend reaches the low level within 4 weeks → attention.
  assert.equal(storageHealth({ totalBytes: 1000 * GB, freeBytes: 80 * GB }, T, { enough: true, message: '', ratePerWeekBytes: 20 * GB }).status, 'attention');
  assert.equal(storageHealth({ totalBytes: 1000 * GB, freeBytes: 30 * GB }, { ...T, attention: { gb: 20, percent: 2 }, low: { gb: 15, percent: 1.5 }, critical: { gb: 5, percent: 1 } }).status, 'healthy');
});

/* ═════════════ Cleanup risk & safety ═════════════ */

test('storage · cleanup risk classification (never “safe to delete”)', () => {
  const now = NOW;
  const ctx = { active: false, runningServices: 0, now };
  assert.equal(assessRisk('git', ruleById('git'), ctx).risk, 'PROTECTED');
  assert.equal(assessRisk('source', null, ctx).risk, 'PROTECTED');
  assert.equal(assessRisk('cache', ruleById('turbo'), ctx).risk, 'SAFE_TO_REVIEW');
  assert.equal(assessRisk('build', ruleById('next'), ctx).risk, 'SAFE_TO_REVIEW');
  assert.equal(assessRisk('dependencies', ruleById('node_modules'), ctx).risk, 'REVIEW_CAREFULLY', 'dependencies are never “safe” by default');
  assert.equal(assessRisk('dependencies', ruleById('vendor'), ctx).recoverable, false);
  assert.equal(assessRisk('logs', ruleById('logs'), { ...ctx, modifiedAt: new Date(now - DAY).toISOString() }).risk, 'REVIEW_CAREFULLY');
  assert.equal(assessRisk('logs', ruleById('logs'), { ...ctx, modifiedAt: new Date(now - 30 * DAY).toISOString() }).risk, 'SAFE_TO_REVIEW');
  assert.equal(assessRisk('build', ruleById('dist'), { ...ctx, git: 'tracked' }).risk, 'PROTECTED', 'tracked by Git → part of the project');
  assert.equal(assessRisk('build', ruleById('dist'), { ...ctx, git: 'untracked' }).risk, 'REVIEW_CAREFULLY', 'untracked is not permission');
  assert.equal(largeFileRisk({ extension: 'mov', inDownloads: false }).risk, 'PROTECTED', 'videos are user data');
  assert.equal(largeFileRisk({ extension: 'iso', inDownloads: false }).risk, 'REVIEW_CAREFULLY');
});

test('storage · active project gets conservative recommendations', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'Dev/live', { runningServices: 2, status: 'RUNNING' }), project(h, 'Dev/legacy')] });
  jsRepo(join(home, 'Dev/live'));
  jsRepo(join(home, 'Dev/legacy'), { ageMs: 200 * DAY });
  approve('Dev');
  await engine.storage.scanAll();
  const live = (await engine.storage.developerDetail('Dev-live')).repo;
  assert.equal(live.isActiveProject, true);
  const nm = live.breakdown.find(e => e.name === 'node_modules')!;
  assert.equal(nm.risk, 'REVIEW_CAREFULLY');
  assert.equal(nm.recoverable, false, 'dependencies of active work are not counted as recoverable');
  assert.equal(live.breakdown.find(e => e.name === 'dist')!.risk, 'REVIEW_CAREFULLY', 'a running service may use its build output');
  assert.equal(live.breakdown.find(e => e.name === '.next')!.risk, 'REVIEW_CAREFULLY');
  assert.equal(live.breakdown.find(e => e.name === 'coverage')!.risk, 'SAFE_TO_REVIEW', 'caches stay reviewable');

  const legacy = await engine.storage.developerDetail('Dev-legacy');
  assert.equal(legacy.repo.isActiveProject, false);
  assert.equal(legacy.old, true, 'inactive for more than 90 days');
  assert.equal(legacy.repo.breakdown.find(e => e.name === 'node_modules')!.recoverable, true);
  assert.ok(legacy.repo.recoverableEstimateBytes > live.recoverableEstimateBytes);
  assert.ok(legacy.repo.recoverableEstimateBytes < legacy.repo.totalBytes, 'the repository itself is never “recoverable”');
});

test('storage · recently used work (WorkNEX) is protected from aggressive suggestions', async () => {
  const { engine, home, approve } = makeEngine({
    projects: h => [project(h, 'W/app')],
    contexts: h => [{ id: 'c1', title: 'App', type: 'development', startedAt: new Date(NOW - 3600_000).toISOString(), lastActiveAt: new Date(NOW).toISOString(), isActive: true, files: [{ name: 'webpack.pack', path: join(h, 'W/app/.next/cache/webpack.pack') }] }],
  });
  jsRepo(join(home, 'W/app'), { ageMs: 200 * DAY });
  approve('W');
  await engine.storage.scanAll();
  const repo = (await engine.storage.developerDetail('W-app')).repo;
  assert.equal(repo.recentlyUsed, true);
  assert.equal(repo.isActiveProject, true, 'WorkNEX activity makes the project active');
  const next = (await engine.storage.candidates()).find(c => c.name === '.next')!;
  assert.equal(next.recoverable, false);
  assert.match(next.reason, /Used today \(WorkNEX\)/);
});

test('storage · Git-tracked build output is protected and never a candidate', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'G/lib')], git: p => (p.endsWith('dist') ? 'tracked' : 'ignored') });
  jsRepo(join(home, 'G/lib'), { ageMs: 200 * DAY });
  approve('G');
  await engine.storage.scanAll();
  const c = await engine.storage.candidates();
  assert.ok(!c.some(x => x.name === 'dist'));
  assert.equal((await engine.storage.developerDetail('G-lib')).repo.breakdown.find(e => e.name === 'dist')!.risk, 'PROTECTED');
});

test('safety · source and .env are protected; .env is never named', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'S/app')] });
  jsRepo(join(home, 'S/app'), { ageMs: 200 * DAY });
  sparse(join(home, 'S/app/.env.production'), 200 * MB, 400 * DAY); // even a huge .env
  sparse(join(home, 'S/app/data/local.sqlite'), 150 * MB, 400 * DAY);
  approve('S');
  await engine.storage.scanAll();
  const cands = await engine.storage.candidates();
  assert.ok(cands.every(c => c.risk !== 'PROTECTED'));
  assert.ok(!cands.some(c => c.type === 'source' || c.path.endsWith('/src') || c.name === '.git'));
  const all = JSON.stringify({ a: engine.storage.history.analyses(), c: cands, l: await engine.storage.largeFiles(100) });
  assert.ok(!all.includes('.env'), '.env files are counted in size but never named');
  const large = await engine.storage.largeFiles(100);
  assert.equal(large.files.find(f => f.name === 'local.sqlite')?.risk, 'PROTECTED', 'local databases are protected');
  assert.ok(!cands.some(c => c.path.includes('local.sqlite')), 'databases are not suggested for cleanup');
});

test('safety · cleanup preview lists exact paths, how each would be removed, and deletes nothing', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'C/old'), project(h, 'C/other')] });
  jsRepo(join(home, 'C/old'), { ageMs: 200 * DAY });
  jsRepo(join(home, 'C/other'), { ageMs: 200 * DAY });
  approve('C');
  await engine.storage.scanAll();
  const cands = await engine.storage.candidates();
  const pick = cands.filter(c => ['node_modules', '.next', 'coverage'].includes(c.name));
  assert.equal(pick.length, 6);
  const p = await engine.storage.cleanupPreview([...pick.map(c => c.id), 'not-a-real-id']);
  assert.equal(p.selected, 6);
  assert.equal(p.projectsAffected, 2);
  assert.deepEqual(p.items.map(i => i.path).sort(), pick.map(c => c.path).sort(), 'exact paths, nothing hidden');
  assert.equal(p.totalBytes, 2 * (51_000 + 30_000 + 4000));
  assert.deepEqual(p.unknown, ['not-a-real-id']);
  assert.ok(p.items.every(i => i.method === 'delete' && i.removable), 'regeneratable folders are deleted permanently (the Trash frees nothing)');
  assert.ok(p.token, 'a one-time token for confirming exactly this preview');
  assert.equal(p.allowDelete, false, 'deleting is off by default');
  for (const c of pick) assert.ok(existsSync(c.path), `${c.path} still exists`);
  // The only engine operation that removes anything is the confirmed cleanup.
  const methods = Object.getOwnPropertyNames(StorageEngine.prototype);
  const destructive = methods.filter(m => /delete|remove(?!d)|prune|trash|unlink|purge|wipe|^rm|^clean(?!up(Preview|Report|Plan|Status|History)$)/i.test(m));
  assert.deepEqual(destructive, ['cleanupConfirm'], 'one removal entry point');
  await assert.rejects(engine.storage.cleanupPreview([]), /at least one/);
});

test('cleanup · nothing is removed unless deleting is allowed, the preview is fresh and (when needed) “delete” is typed', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'C/old')] });
  jsRepo(join(home, 'C/old'), { ageMs: 200 * DAY });
  approve('C');
  await engine.storage.scanAll();
  const pick = (await engine.storage.candidates()).filter(c => ['node_modules', '.next', 'coverage'].includes(c.name));
  const p = await engine.storage.cleanupPreview(pick.map(c => c.id));
  await assert.rejects(engine.storage.cleanupConfirm({ token: p.token, confirm: 'delete' }), /turned off/);
  engine.storage.updateSettings({ allowDelete: true });
  await assert.rejects(engine.storage.cleanupConfirm({ token: 'made-up', confirm: 'delete' }), /expired/);
  if (p.requireTyped) await assert.rejects(engine.storage.cleanupConfirm({ token: p.token }), /Type “delete”/);
  for (const c of pick) assert.ok(existsSync(c.path), 'refused confirmations remove nothing');

  const run = await engine.storage.cleanupConfirm({ token: p.token, confirm: 'delete' });
  assert.equal(run.state, 'done');
  assert.deepEqual(run.items.map(i => i.state), ['done', 'done', 'done']);
  for (const c of pick) assert.ok(!existsSync(c.path), `${c.name} removed`);
  for (const keep of ['package.json', 'src/index.ts', '.env', '.git/objects/pack/p.pack', 'public/logo.png', 'dist/main.js']) assert.ok(existsSync(join(home, 'C/old', keep)), `${keep} untouched`);
  assert.match(run.items.find(i => i.path.endsWith('node_modules'))!.message!, /npm install/);
  await assert.rejects(engine.storage.cleanupConfirm({ token: p.token, confirm: 'delete' }), /expired/, 'a token works once');
  assert.equal(engine.storage.cleanupHistory().length, 3, 'kept in the local cleanup history');
  assert.ok(!(await engine.storage.candidates()).some(c => pick.some(x => x.path === c.path)), 'removed items leave the list at once');
});

test('cleanup · every item is re-checked right before removal (changed, running, no longer approved, protected)', async () => {
  let running = 0;
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'R/a'), project(h, 'R/b', { runningServices: running })] });
  jsRepo(join(home, 'R/a'), { ageMs: 200 * DAY });
  jsRepo(join(home, 'R/b'), { ageMs: 200 * DAY });
  approve('R');
  engine.storage.updateSettings({ allowDelete: true });
  await engine.storage.scanAll();
  const c = await engine.storage.candidates();
  const aNm = c.find(x => x.path === join(home, 'R/a/node_modules'))!, aCov = c.find(x => x.path === join(home, 'R/a/coverage'))!, bNext = c.find(x => x.path === join(home, 'R/b/.next'))!;
  const p = await engine.storage.cleanupPreview([aNm.id, aCov.id, bNext.id]);
  file(join(home, 'R/a/node_modules/new-package/index.js'), 10); // node_modules changed after the preview
  age(join(home, 'R/a/node_modules'), 0);
  running = 2; // R/b started its services after the preview
  const run = await engine.storage.cleanupConfirm({ token: p.token, confirm: 'delete' });
  const by = (path: string) => run.items.find(i => i.path === path)!;
  assert.equal(by(aNm.path).state, 'skipped'); assert.match(by(aNm.path).message!, /changed/);
  assert.equal(by(bNext.path).state, 'skipped'); assert.match(by(bNext.path).message!, /running|active work/);
  assert.equal(by(aCov.path).state, 'done');
  assert.ok(existsSync(aNm.path) && existsSync(bNext.path) && !existsSync(aCov.path));

  // A folder that stops being approved: nothing inside it is removed on an older confirmation.
  const p2 = await engine.storage.cleanupPreview([c.find(x => x.path === join(home, 'R/a/.next'))!.id]);
  engine.updateLocation(engine.settings().locations[0].id, { paused: true });
  const run2 = await engine.storage.cleanupConfirm({ token: p2.token, confirm: 'delete' });
  assert.equal(run2.items[0].state, 'skipped');
  assert.ok(existsSync(join(home, 'R/a/.next')));
  // Protected or unknown ids never get a token.
  const p3 = await engine.storage.cleanupPreview(['not-a-real-id']);
  assert.equal(p3.token, null);
});

test('cleanup · your files go to the Trash, worktrees via git worktree remove, Docker via its own command', async () => {
  const docker = async (): Promise<DockerStorage> => ({ ...(await dockerOff()), available: true, detail: null, buildCache: { bytes: 5 * GB, reclaimableBytes: 4 * GB, count: 10 }, volumes: { bytes: 2 * GB, reclaimableBytes: 2 * GB, count: 3 } });
  const { engine, home, approve, trashed, ran } = makeEngine({ projects: h => [project(h, 'Dev/topo')], worktree: p => { const g = wtGit(p); return g ? { ...g, mainPath: join(home, 'Dev/topo') } : null; }, docker });
  withWorktree(home);
  sparse(join(home, 'Downloads/old-installer.dmg'), 50 * MB, 200 * DAY);
  approve('Dev'); approve('Downloads');
  engine.storage.updateSettings({ allowDelete: true });
  await engine.storage.scanAll();
  const c = await engine.storage.candidates();
  const dl = c.find(x => x.group === 'downloads')!, wt = c.find(x => x.group === 'worktrees')!, bc = c.find(x => x.id === 'docker-build-cache')!, vol = c.find(x => x.id === 'docker-volumes')!;
  assert.equal(dl.method, 'trash');
  assert.equal(wt.method, 'git-worktree');
  assert.deepEqual(bc.command, ['docker', 'builder', 'prune', '-f']);
  assert.equal(vol.removable, false, 'Docker volumes can hold databases — never removed by FileNEX');
  const p = await engine.storage.cleanupPreview([dl.id, wt.id, bc.id, vol.id]);
  assert.equal(p.removable, 3);
  assert.equal(p.requireTyped, true, 'review-carefully items need the typed word');
  const run = await engine.storage.cleanupConfirm({ token: p.token, confirm: 'delete' });
  assert.deepEqual(run.items.map(i => i.state), ['done', 'done', 'done']);
  assert.deepEqual(trashed, [dl.path]);
  assert.deepEqual(ran.sort(), ['docker builder prune -f', `git -C ${join(home, 'Dev/topo')} worktree remove ${wt.path}`].sort());
  assert.ok(!run.items.some(i => i.id === vol.id), 'not removable → not in the run at all');
  assert.ok(existsSync(join(home, 'Dev/topo/.claude/worktrees/agent-acb7068abac617b2c')), 'the worktree with uncommitted changes stays');
});

test('safety · clearing storage history does not delete any file', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'H/app')] });
  jsRepo(join(home, 'H/app'));
  approve('H');
  await engine.storage.scanAll();
  assert.ok(engine.storage.history.counts().snapshots > 0);
  const r = engine.storage.clearHistory(true);
  assert.equal(r.filesTouched, 0);
  assert.deepEqual(engine.storage.history.counts(), { snapshots: 0, repoSnapshots: 0, analyses: 0 });
  for (const p of ['package.json', 'src/index.ts', '.env', 'node_modules/react/index.js', '.git/objects/pack/p.pack']) assert.ok(existsSync(join(home, 'H/app', p)), p);
});

test('safety · open/reveal only for items FileNEX found in approved folders', async () => {
  const { engine, home, approve, opened } = makeEngine();
  sparse(join(home, 'V/backup.iso'), 300 * MB, 400 * DAY);
  file(join(home, 'Private/x.txt'), 10);
  approve('V');
  await engine.storage.scanAll();
  await engine.storage.reveal(join(home, 'V/backup.iso'));
  assert.deepEqual(opened, [`reveal:${join(home, 'V/backup.iso')}`]);
  await assert.rejects(engine.storage.open(join(home, 'Private/x.txt')), /only opens items/);
  await assert.rejects(engine.storage.open('relative/path'), /full path/);
});

/* ═════════════ Large files, Docker, search, attention ═════════════ */

test('storage · large files with threshold and sorting', async () => {
  const { engine, home, approve } = makeEngine();
  sparse(join(home, 'M/ubuntu-image.iso'), 1200 * MB, 300 * DAY);
  sparse(join(home, 'M/screen-recording.mov'), 700 * MB, 2 * DAY);
  sparse(join(home, 'M/small.zip'), 120 * MB, 10 * DAY);
  approve('M');
  await engine.storage.scanAll();
  assert.deepEqual((await engine.storage.largeFiles(500)).files.map(f => f.name), ['ubuntu-image.iso', 'screen-recording.mov']);
  assert.deepEqual((await engine.storage.largeFiles(1024)).files.map(f => f.name), ['ubuntu-image.iso']);
  assert.deepEqual((await engine.storage.largeFiles(100, 'oldest')).files.map(f => f.name), ['ubuntu-image.iso', 'small.zip', 'screen-recording.mov']);
  assert.ok((await engine.storage.candidates()).some(c => c.group === 'large-old' && c.name === 'ubuntu-image.iso'));
  assert.ok(!(await engine.storage.candidates()).some(c => c.name === 'screen-recording.mov'), 'videos are never suggested');
});

test('storage · Docker sizes parse; unavailable Docker is reported, never an error', async () => {
  assert.equal(parseDockerSize('18.2GB'), 18_200_000_000);
  assert.equal(parseDockerSize('512MB'), 512_000_000);
  assert.equal(parseDockerSize('0B'), 0);
  const df = parseSystemDf(['{"Type":"Images","TotalCount":"5","Active":"2","Size":"2.6GB","Reclaimable":"1.2GB (45%)"}', '{"Type":"Build Cache","TotalCount":"9","Active":"0","Size":"780MB","Reclaimable":"780MB"}'].join('\n'));
  assert.equal(df.images.reclaimableBytes, 1_200_000_000);
  assert.equal(df.buildCache.bytes, 780_000_000);
  const { engine } = makeEngine();
  const o = await engine.storage.overview();
  assert.equal(o.docker?.available, false);
});

test('storage · developer search: names and simple size filters', () => {
  const r = (name: string, deps: number, build = 0): RepositoryStorage => ({ projectId: name, name, path: `/x/${name}`, available: true, totalBytes: deps + build + GB, sourceBytes: GB, dependencyBytes: deps, buildBytes: build, cacheBytes: 0, logBytes: 0, gitBytes: 0, otherBytes: 0, recoverableEstimateBytes: 0, lastActiveAt: null, lastActiveSource: null, isActiveProject: false, recentlyUsed: false, inactiveDays: null, runningServiceCount: 0, analyzedAt: null, growth7dBytes: null, nested: false, worktrees: [], breakdown: [] });
  const repos = [r('SmartFlowNEX', 7.8 * GB, 5 * GB), r('NEXWorkbench', 3 * GB), r('QANEX', 6 * GB)];
  assert.deepEqual(filterRepos(repos, 'smartflow').map(x => x.name), ['SmartFlowNEX']);
  assert.deepEqual(filterRepos(repos, 'node_modules > 5GB').map(x => x.name), ['SmartFlowNEX', 'QANEX']);
  assert.deepEqual(filterRepos(repos, 'node_modules > 5GB build >= 1gb').map(x => x.name), ['SmartFlowNEX']);
  assert.deepEqual(filterRepos(repos, 'total < 5000mb').map(x => x.name), ['NEXWorkbench']);
});

test('storage · low disk space raises one Workbench attention item; healthy raises none', async () => {
  const low = makeEngine({ free: 18 });
  const items = await low.engine.storage.attention();
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'warning');
  assert.equal(items[0].title, 'Disk space is low');
  assert.equal(items[0].action, '/filenex/storage');
  assert.deepEqual(await makeEngine({ free: 300 }).engine.storage.attention(), []);
  assert.equal((await makeEngine({ free: 5 }).engine.storage.attention())[0].severity, 'critical');
});

test('storage · repo snapshots feed repository growth', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'R/app')] });
  jsRepo(join(home, 'R/app'));
  approve('R');
  await engine.storage.scanAll();
  const row = engine.storage.history.repoSnapshots(0)[0];
  assert.equal(row.dependencyBytes, 51_000);
  engine.storage.history.addRepoSnapshots([{ ...row, timestamp: new Date(NOW - 7 * DAY).toISOString(), totalBytes: row.totalBytes - 5 * GB, dependencyBytes: row.dependencyBytes - 2 * GB, buildBytes: row.buildBytes - 3 * GB }]);
  const g = await engine.storage.growth(7);
  assert.equal(g.repos[0].name, 'app');
  assert.equal(g.repos[0].deltaBytes, 5 * GB);
  assert.equal(g.repos[0].parts[0].key, 'build');
  const att = await engine.storage.attention();
  assert.match(att.find(a => a.id.includes('growth'))!.title, /app grew by 5\.0 GB this week/);
});

test('storage · devSummary dedupes and builds footprints', () => {
  const analyses: LocationAnalysis[] = [{
    locationId: 'L', path: '/w', label: 'w', analyzedAt: new Date(NOW).toISOString(), durationMs: 1, totalBytes: 100, entries: 1, errors: 0, truncated: false, folders: [], logs: [], largeFiles: [], downloads: [],
    artifacts: [{ path: '/w/a/node_modules', name: 'node_modules', rule: 'node_modules', category: 'dependencies', runtime: 'node', regeneratable: true, bytes: 60, files: 1, modifiedAt: null, measuredAt: new Date(NOW).toISOString(), projectRoot: '/w/a' }],
    roots: [{ path: '/w/a', totalBytes: 100, sourceBytes: 40, otherBytes: 0, looseLogBytes: 0, protectedBytes: 0, newestSourceAt: new Date(NOW - 200 * DAY).toISOString() }],
  }];
  const repos = buildRepositories({ projects: [{ id: 'a', name: 'a', path: '/w/a', runningServices: 0, status: 'STOPPED', composeProjects: [] }], analyses, settings: { locations: [{ id: 'L', path: '/w', label: 'w', paused: false, addedAt: '', excludedFolders: [] }] }, contexts: [], now: NOW, inactiveDays: 90 });
  const s = devSummary(repos, []);
  assert.equal(s.totalBytes, 100);
  assert.equal(s.recoverableBytes, 60);
  assert.equal(s.dependencies.groups[0].repos[0].bytes, 60);
});

/* ═════════════ Git worktrees & readable names ═════════════ */

function withWorktree(home: string) {
  jsRepo(join(home, 'Dev/topo'), { ageMs: 200 * DAY });
  for (const id of ['agent-a00dc7b27f994ff86', 'agent-acb7068abac617b2c']) {
    const w = join(home, 'Dev/topo/.claude/worktrees', id);
    jsRepo(w, { ageMs: 3 * DAY });
    rmSync(join(w, '.git'), { recursive: true });
    file(join(w, '.git'), 60, 3 * DAY); // a worktree's .git is a file
    file(join(w, 'frontend/package.json'), 100, 3 * DAY);
    file(join(w, 'frontend/node_modules/vite/index.js'), 70_000, 3 * DAY);
  }
}
const wtGit = (p: string): WorktreeGit | null => p.endsWith('agent-a00dc7b27f994ff86')
  ? { branch: 'fix/cr-075-length-limits-backup-hash', lastCommitAt: new Date(NOW - 3 * DAY).toISOString(), lastCommitSubject: 'fix(limits): CR-075 clear invalid links', uncommitted: 0, mainPath: null }
  : p.endsWith('agent-acb7068abac617b2c') ? { branch: 'feat/cr-046-group-compose', lastCommitAt: new Date(NOW - 3 * DAY).toISOString(), lastCommitSubject: 'feat(editor): group steps', uncommitted: 11, mainPath: null } : null;

test('worktrees · a clean Git worktree is one readable row named by its branch', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'Dev/topo')], worktree: wtGit });
  withWorktree(home);
  approve('Dev');
  await engine.storage.scanAll();
  const a = engine.storage.currentAnalyses()[0];
  assert.equal(a.worktrees?.length, 2, 'folders whose .git is a file are worktrees');
  const c = await engine.storage.candidates();
  const wt = c.filter(x => x.group === 'worktrees');
  assert.equal(wt.length, 1, 'only the worktree without uncommitted changes is suggested');
  assert.equal(wt[0].label, 'fix/cr-075-length-limits-backup-hash');
  assert.match(wt[0].detail!, /topo · worktree agent-a00dc7b27f994ff86 · last commit 3 days ago: fix\(limits\)/);
  assert.equal(wt[0].recoverable, true);
  assert.equal(wt[0].regenerate, `git worktree remove "${join(home, 'Dev/topo/.claude/worktrees/agent-a00dc7b27f994ff86')}"`);
  assert.ok(!c.some(x => x.group !== 'worktrees' && x.path.includes('agent-a00dc7b27f994ff86')), 'its node_modules are inside the one row, not listed again');
  // The worktree with 11 uncommitted changes is never suggested; its folders stay individual, with readable names.
  const dirty = c.filter(x => x.path.includes('agent-acb7068abac617b2c'));
  assert.ok(dirty.length > 0 && dirty.every(x => x.group !== 'worktrees'));
  const fe = dirty.find(x => x.path.endsWith('frontend/node_modules'))!;
  assert.equal(fe.label, 'frontend/node_modules');
  assert.equal(fe.detail, 'topo · worktree feat/cr-046-group-compose');
  // The main repository's own folders are labelled relative to the project.
  const main = c.find(x => x.path === join(home, 'Dev/topo/node_modules'))!;
  assert.equal(main.label, 'node_modules');
  assert.equal(main.detail, 'topo');
  // Repo detail lists its worktrees; totals are unchanged (worktree bytes are already in the categories).
  const repo = (await engine.storage.developerDetail('Dev-topo')).repo;
  assert.deepEqual(repo.worktrees.map(w => w.name).sort(), ['feat/cr-046-group-compose', 'fix/cr-075-length-limits-backup-hash']);
  assert.equal(repo.worktrees.find(w => w.uncommitted === 11)!.inUse, true);
  assert.equal(repo.totalBytes, repo.sourceBytes + repo.dependencyBytes + repo.buildBytes + repo.cacheBytes + repo.logBytes + repo.gitBytes + repo.otherBytes);
  // Recovery counts the worktree once (not also its node_modules).
  const p = await engine.storage.cleanupPreview(c.filter(x => x.path.startsWith(join(home, 'Dev/topo/.claude'))).map(x => x.id));
  assert.equal(p.overlapping, 0);
});

test('worktrees · unknown Git state or recent activity is never counted as recoverable', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'Dev/topo')], worktree: p => (p.endsWith('agent-a00dc7b27f994ff86') ? { ...wtGit(p)!, lastCommitAt: new Date(NOW - 2 * 3600_000).toISOString() } : null) });
  withWorktree(home);
  approve('Dev');
  await engine.storage.scanAll();
  const c = await engine.storage.candidates();
  const wt = c.find(x => x.group === 'worktrees')!;
  assert.equal(wt.recoverable, false);
  assert.match(wt.reason, /active 2 hours ago/);
  assert.ok(!c.some(x => x.group === 'worktrees' && x.path.includes('agent-acb7')), 'unknown Git state → not suggested');
});

test('safety · exported report for an assistant: exact paths, safety rules, scope, nothing deleted', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'E/old')] });
  jsRepo(join(home, 'E/old'), { ageMs: 200 * DAY });
  approve('E');
  await engine.storage.scanAll();
  const md = await engine.storage.cleanupReport();
  assert.match(md, /Never delete anything without the user’s explicit confirmation/);
  assert.match(md, /Only touch paths listed in this report/);
  assert.ok(md.includes(`\`${join(home, 'E/old/node_modules')}\``), 'exact path');
  assert.ok(!md.includes('.env'.concat('`')) && !md.includes('/src`'), 'protected items are not listed');
  const ids = (await engine.storage.candidates()).filter(c => c.name === '.next').map(c => c.id);
  const sel = await engine.storage.cleanupReport({ ids });
  assert.match(sel, /Scope: 1 selected item/);
  assert.ok(!sel.includes('node_modules`'));
  assert.ok(existsSync(join(home, 'E/old/node_modules')));
  assert.match(cleanupReportMarkdown([], { now: NOW, scope: 'x' }), /potentially recoverable \(conservative, each byte once\):\*\* 0/);
});

test('plan · suggested steps: build output first, idle deps with keep list, worktrees checked, personal files left to the user', async () => {
  const { engine, home, approve } = makeEngine({ projects: h => [project(h, 'P/live', { runningServices: 1, status: 'RUNNING' }), project(h, 'P/old-a'), project(h, 'P/old-b')], worktree: wtGit });
  jsRepo(join(home, 'P/live'));
  jsRepo(join(home, 'P/old-a'), { ageMs: 200 * DAY });
  jsRepo(join(home, 'P/old-b'), { ageMs: 200 * DAY });
  withWorktree(home);
  file(join(home, 'Downloads/old-thing.bin'), 11 * MB, 300 * DAY);
  approve('P'); approve('Dev'); approve('Downloads');
  await engine.storage.scanAll();
  const plan = await engine.storage.cleanupPlan();
  assert.match(plan.headline, /Nothing is deleted until you confirm/);
  assert.deepEqual(plan.steps.map(s => s.key), ['build', 'idle-deps', 'check-first', 'your-call']);
  const build = plan.steps[0];
  assert.ok(build.items.some(i => i.label === 'old-a/.next'), 'labels are relative to the approved folder');
  assert.ok(!build.items.some(i => i.label.startsWith('live/')), 'running project skipped');
  assert.ok(build.keep.some(k => k.label === 'live' && /services are running/.test(k.reason)));
  const deps = plan.steps[1];
  assert.deepEqual(deps.items.map(i => i.label).sort(), ['old-a/node_modules', 'old-b/node_modules', 'topo/node_modules']);
  assert.ok(deps.keep.some(k => k.label === 'live'));
  const check = plan.steps[2];
  assert.ok(check.items.some(i => /worktree feat\/cr-046-group-compose/i.test(i.label) && /uncommitted/.test(i.note ?? '')));
  assert.deepEqual(plan.steps[2].ids, [], '“check first” never offers bulk selection');
  assert.deepEqual(plan.steps[3].ids, [], 'personal files are never bulk-selected');
  assert.ok(plan.steps[3].items.some(i => /Old downloads/.test(i.label)));
  const md = await engine.storage.cleanupReport();
  assert.match(md, /## Suggested plan[\s\S]*### 1\. Build output/);
});
