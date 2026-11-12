import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { conflictMessage } from '../engine';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PortInfo, ProcessInfo } from '@nex/shared';
import {
  findProjectRoot, isProjectDir, packageManagerOf, projectId, projectName, scanRoot, signalsOf,
} from '../project-engine/discovery';
import { ProjectRegistry } from '../project-engine/registry';
import { portFromScript, serviceDefinitions } from '../project-engine/services';
import { levelOf } from '../project-engine/runner';
import { buildPortTable, exposureOf, findConflicts, projectForPid } from '../port-engine';
import { inspectEnvironment, maskValue, parseEnv } from '../environment-engine';
import { checkRuntimes, parseVersion, satisfies } from '../runtime-engine';
import { parseGitStatus } from '../git-engine';
import { dockerInfo, parseDockerPs } from '../docker-engine';
import { evaluateHealth, type HealthInput } from '../service-health';
import type { Container, EnvReport, PortEntry, Project, RuntimeCheck, Service } from '../types';

/* ── helpers ── */
const TMP_ROOTS: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'devnex-test-')); TMP_ROOTS.push(d); return d; };
after(() => { for (const d of TMP_ROOTS) rmSync(d, { recursive: true, force: true }); });

/** Write files relative to `root`; a value of null creates a directory. */
const tree = (root: string, files: Record<string, string | object | null>) => {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    if (content === null) { mkdirSync(p, { recursive: true }); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
};

const SIGNALS = { packageJson: true, devnexConfig: false, pnpmWorkspace: false, turbo: false, compose: null, envExample: false, git: false };

const svc = (o: Partial<Service> & { id: string }): Service => ({
  name: o.id.split(':').pop()!, type: 'app', command: 'npm run dev', port: null, source: 'package.json',
  projectId: 'p', status: 'STOPPED', managedBy: null, hasLogs: false, pid: null, cpuPercent: null, memoryBytes: null,
  startedAt: null, exitCode: null, health: 'unknown', detail: null, ...o,
});
const proj = (id: string, path: string, services: Partial<Service>[] = [], o: Partial<Project> = {}): Project => ({
  id, name: id, path, origin: 'registered', signals: SIGNALS, packageManager: 'npm', status: 'STOPPED', usage: { cpuPercent: 0, memoryBytes: 0, processCount: 0, basis: 'none' },
  services: services.map((s, i) => svc({ id: `${id}:s${i}`, projectId: id, ...s })), ...o,
});
const entry = (o: Partial<PortEntry> & { port: number }): PortEntry => ({
  address: '127.0.0.1', exposure: 'loopback', pid: null, processName: null, command: null, cwd: null,
  projectId: null, projectName: null, serviceId: null, serviceName: null, unknown: true, ...o,
});
const proc = (pid: number, ppid: number, name: string, command = name): ProcessInfo =>
  ({ pid, ppid, name, command, cpu: 0, memory: 100 * 1024 ** 2, user: 'me' });
const portInfo = (port: number, pid: number | null, address = '127.0.0.1', processName: string | null = null): PortInfo =>
  ({ port, pid, address, processName, protocol: 'tcp' });

/* ── 1. Project discovery ── */
test('discovery: signalsOf reports every marker file', () => {
  const d = tree(tmp(), {
    'package.json': { name: 'x' }, 'devnex.config.json': {}, 'pnpm-workspace.yaml': 'packages: []', 'turbo.json': '{}',
    'compose.yaml': 'services: {}', '.env.example': 'A=', '.git': null,
  });
  assert.deepEqual(signalsOf(d), { packageJson: true, devnexConfig: true, pnpmWorkspace: true, turbo: true, compose: 'compose.yaml', envExample: true, git: true });
  assert.deepEqual(signalsOf(tmp()), { packageJson: false, devnexConfig: false, pnpmWorkspace: false, turbo: false, compose: null, envExample: false, git: false });
});

test('discovery: compose file names are found in priority order', () => {
  const d = tree(tmp(), { 'compose.yml': '', 'docker-compose.yaml': '' });
  assert.equal(signalsOf(d).compose, 'docker-compose.yaml');
});

test('discovery: isProjectDir requires package.json, devnex config or compose', () => {
  assert.equal(isProjectDir(tree(tmp(), { 'package.json': {} })), true);
  assert.equal(isProjectDir(tree(tmp(), { 'devnex.config.json': {} })), true);
  assert.equal(isProjectDir(tree(tmp(), { 'docker-compose.yml': '' })), true);
  // .git or .env.example alone are not enough.
  assert.equal(isProjectDir(tree(tmp(), { '.git': null, '.env.example': 'A=' })), false);
});

test('discovery: scanRoot finds projects to depth, skips node_modules/dotdirs and does not descend into projects', () => {
  const root = tree(tmp(), {
    'web/package.json': {},
    'web/packages/ui/package.json': {}, // nested inside a project → not listed separately
    'clients/acme/api/package.json': {}, // depth 3 → out of default depth 2
    'clients/beta/compose.yml': '',
    'node_modules/lib/package.json': {},
    '.hidden/app/package.json': {},
    'dist/package.json': {},
    'notes/readme.txt': 'hi',
  });
  const found = scanRoot(root).map(p => p.slice(root.length + 1)).sort();
  assert.deepEqual(found, ['clients/beta', 'web']);
  assert.deepEqual(scanRoot(root, 3).map(p => p.slice(root.length + 1)).sort(), ['clients/acme/api', 'clients/beta', 'web']);
  assert.equal(scanRoot(root, 3, 1).length, 1);
  // A root that is itself a project returns just itself.
  assert.deepEqual(scanRoot(join(root, 'web')), [join(root, 'web')]);
});

test('discovery: findProjectRoot climbs to the outermost project, stops at git root, never above home', () => {
  const home = tmp();
  tree(home, {
    'code/mono/.git': null, 'code/mono/package.json': {}, 'code/mono/packages/web/package.json': {}, 'code/mono/packages/web/src/app': null,
    'code/loose/package.json': {}, 'code/loose/sub/package.json': {}, 'code/loose/sub/deep': null,
    'code/cfg/devnex.config.json': {}, 'code/cfg/apps/api/package.json': {},
    'code/empty/folder': null,
    '.vscode/extensions/ext/package.json': {},
    'Library/Thing/package.json': {},
    'code/x/node_modules/pkg/package.json': {},
  });
  assert.equal(findProjectRoot(join(home, 'code/mono/packages/web/src/app'), home), join(home, 'code/mono'));
  assert.equal(findProjectRoot(join(home, 'code/loose/sub/deep'), home), join(home, 'code/loose'));
  assert.equal(findProjectRoot(join(home, 'code/cfg/apps/api'), home), join(home, 'code/cfg'));
  assert.equal(findProjectRoot(join(home, 'code/empty/folder'), home), null);
  assert.equal(findProjectRoot(join(home, '.vscode/extensions/ext'), home), null);
  assert.equal(findProjectRoot(join(home, 'Library/Thing'), home), null);
  assert.equal(findProjectRoot(join(home, 'code/x/node_modules/pkg'), home), null);
  assert.equal(findProjectRoot(home, home), null);
  assert.equal(findProjectRoot(tmp(), home), null, 'path outside home');
  // A sibling folder whose name merely starts with the home path is not inside home.
  assert.equal(findProjectRoot(`${home}-other/proj`, home), null);
});

test('discovery: projectName precedence config > package.json > folder', () => {
  const both = tree(tmp(), { 'devnex.config.json': { name: 'From Config' }, 'package.json': { name: 'from-pkg' } });
  const pkg = tree(tmp(), { 'package.json': { name: 'from-pkg' } });
  const badCfg = tree(tmp(), { 'devnex.config.json': { name: 42 }, 'package.json': { name: 'from-pkg' } });
  const folder = join(tree(tmp(), { 'my-folder/package.json': '{ not json' }), 'my-folder');
  assert.equal(projectName(both), 'From Config');
  assert.equal(projectName(pkg), 'from-pkg');
  assert.equal(projectName(badCfg), 'from-pkg');
  assert.equal(projectName(folder), 'my-folder');
});

test('discovery: packageManagerOf from lockfiles', () => {
  assert.equal(packageManagerOf(tree(tmp(), { 'package.json': {}, 'pnpm-lock.yaml': '' })), 'pnpm');
  assert.equal(packageManagerOf(tree(tmp(), { 'pnpm-workspace.yaml': '' })), 'pnpm');
  assert.equal(packageManagerOf(tree(tmp(), { 'package.json': {}, 'yarn.lock': '' })), 'yarn');
  assert.equal(packageManagerOf(tree(tmp(), { 'package.json': {}, 'package-lock.json': '{}' })), 'npm');
  assert.equal(packageManagerOf(tree(tmp(), { 'package.json': {} })), 'npm');
  assert.equal(packageManagerOf(tree(tmp(), { 'compose.yml': '' })), null);
});

test('discovery: projectId is stable and path-derived', () => {
  const d = tmp();
  assert.match(projectId(d), /^[0-9a-f]{10}$/);
  assert.equal(projectId(d), projectId(d + '/.'));
  assert.notEqual(projectId(d), projectId(tmp()));
});

/* ── 2. Project registration ── */
test('registry: validate accepts real dirs inside home, expands ~, rejects others', () => {
  const home = tree(tmp(), { 'code/app': null, 'file.txt': 'x' });
  assert.equal(ProjectRegistry.validate(join(home, 'code/app'), home), join(home, 'code/app'));
  assert.equal(ProjectRegistry.validate('~/code/app', home), join(home, 'code/app'));
  assert.throws(() => ProjectRegistry.validate(join(home, 'nope'), home), /does not exist/);
  assert.throws(() => ProjectRegistry.validate(join(home, 'file.txt'), home), /does not exist/);
  assert.throws(() => ProjectRegistry.validate(tmp(), home), /inside your home/);
  assert.throws(() => ProjectRegistry.validate(home, home), /inside your home/);
  assert.throws(() => ProjectRegistry.validate(join(home, 'code/../..'), home), /inside your home/);
  assert.throws(() => ProjectRegistry.validate(`${home}-evil`, home), /inside your home/);
});

test('registry: addProject dedupes, remove hides, re-adding unhides, state persists', () => {
  const home = tree(tmp(), { 'code/a': null, 'code/b': null });
  const file = join(home, '.nex/devnex.json');
  const prevHome = process.env.HOME;
  process.env.HOME = home; // addProject/addRoot validate against os.homedir()
  try {
    const reg = new ProjectRegistry(file);
    assert.deepEqual(reg.get(), { roots: [], projects: [], hidden: [] });
    const a = join(home, 'code/a'), b = join(home, 'code/b');
    reg.addProject(a);
    reg.addProject(a + '/');
    reg.addProject(b);
    assert.deepEqual(reg.get().projects, [a, b]);
    reg.addRoot(join(home, 'code'));
    reg.addRoot(join(home, 'code'));
    assert.deepEqual(reg.get().roots, [join(home, 'code')]);

    reg.remove(a);
    assert.deepEqual(reg.get().projects, [b]);
    assert.deepEqual(reg.get().hidden, [a]);
    reg.remove(a);
    assert.deepEqual(reg.get().hidden, [a], 'hidden is deduped');

    const reloaded = new ProjectRegistry(file);
    assert.deepEqual(reloaded.get().hidden, [a]);
    reloaded.addProject(a);
    assert.deepEqual(reloaded.get().hidden, []);
    assert.deepEqual(reloaded.get().projects, [b, a]);
    assert.throws(() => reloaded.addProject(tmp()), /inside your home/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});

test('registry: malformed state file is normalised', () => {
  const file = join(tmp(), 'reg.json');
  writeFileSync(file, JSON.stringify({ roots: 'x', projects: ['/a', 3, null], hidden: [{}] }));
  assert.deepEqual(new ProjectRegistry(file).get(), { roots: [], projects: ['/a'], hidden: [] });
});

/* ── 3. Service definitions ── */
test('services: portFromScript', () => {
  assert.equal(portFromScript('next dev -p 3100'), 3100);
  assert.equal(portFromScript('vite --port=5173'), 5173);
  assert.equal(portFromScript('vite --host 127.0.0.1 --port 5174'), 5174);
  assert.equal(portFromScript('PORT=4000 node server.js'), 4000);
  assert.equal(portFromScript('next dev'), null);
  assert.equal(portFromScript('tsc -p tsconfig.json'), null);
  assert.equal(portFromScript('serve --port 99999'), null);
});

test('services: devnex.config.json wins over package.json', () => {
  const d = tree(tmp(), {
    'devnex.config.json': { services: [{ name: 'Web App', command: 'npm run dev', port: 3000 }, { name: 'Postgres', port: 70000 }, { nope: true }] },
    'package.json': { scripts: { dev: 'next dev -p 3100' } },
    'compose.yml': '',
  });
  const defs = serviceDefinitions(d, 'p1');
  assert.deepEqual(defs, [
    { id: 'p1:web-app', name: 'Web App', type: 'frontend', command: 'npm run dev', port: 3000, source: 'devnex.config.json' },
    { id: 'p1:postgres', name: 'Postgres', type: 'database', command: null, port: null, source: 'devnex.config.json' },
  ]);
});

test('services: package.json prefers the dev:* family and uses the right package manager', () => {
  const d = tree(tmp(), {
    'package.json': { scripts: { start: 'node dist/server.js', dev: 'turbo dev', 'dev:web': 'next dev -p 3100', 'dev:api': 'PORT=4000 nest start --watch', build: 'tsc', test: 'node --test' } },
    'pnpm-lock.yaml': '',
  });
  const defs = serviceDefinitions(d, 'p');
  assert.deepEqual(defs.map(s => s.name), ['dev', 'dev:web', 'dev:api']);
  assert.deepEqual(defs.map(s => s.command), ['pnpm dev', 'pnpm dev:web', 'pnpm dev:api']);
  assert.deepEqual(defs.map(s => s.port), [null, 3100, 4000]);
  assert.equal(defs[1].type, 'frontend');
  assert.equal(defs[2].type, 'backend');
  assert.equal(defs[1].id, 'p:dev-web');
  assert.ok(defs.every(s => s.source === 'package.json'));
});

test('services: falls back to start/serve scripts (max 3) and adds compose', () => {
  const d = tree(tmp(), {
    'package.json': { scripts: { start: 'node server.js --port 8080', serve: 'x', watch: 'y', develop: 'z', build: 'b' } },
    'docker-compose.yml': 'services: {}',
  });
  const defs = serviceDefinitions(d, 'q');
  assert.deepEqual(defs.map(s => s.name), ['start', 'serve', 'watch', 'docker compose']);
  assert.equal(defs[0].command, 'npm run start');
  assert.equal(defs[0].port, 8080);
  assert.deepEqual(defs[3], { id: 'q:compose', name: 'docker compose', type: 'container', command: null, port: null, source: 'docker-compose' });
});

test('services: project with no scripts and no compose has no services', () => {
  assert.deepEqual(serviceDefinitions(tree(tmp(), { 'package.json': { name: 'lib' } }), 'z'), []);
});

/* ── 4. Port table + conflicts ── */
test('ports: exposureOf', () => {
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost']) assert.equal(exposureOf(a), 'loopback', a);
  for (const a of ['0.0.0.0', '*', '::', '192.168.1.20', '10.0.0.5']) assert.equal(exposureOf(a), 'network', a);
});

test('ports: projectForPid by cwd, command line, ancestor walk; longest path wins', () => {
  const mono = proj('mono', '/Users/me/code/mono');
  const web = proj('web', '/Users/me/code/mono/apps/web');
  const api = proj('api', '/Users/me/code/api');
  const projects = [mono, web, api];
  const processes = new Map<number, ProcessInfo>([
    [100, proc(100, 50, 'node', 'node /Users/me/code/api/dist/server.js')],
    [200, proc(200, 1, 'npm', 'npm run dev')],
    [201, proc(201, 200, 'node', 'node next dev')],
    [202, proc(202, 201, 'next-server', 'next-server (v15)')],
    [300, proc(300, 1, 'node', 'node /Users/me/code/api-old/index.js')],
    [400, proc(400, 1, 'vite', 'vite')],
  ]);
  const cwds = new Map<number, string>([[200, '/Users/me/code/mono/apps/web'], [400, '/Users/me/code/mono/packages/ui']]);
  const ctx = { processes, cwds, projects };
  assert.equal(projectForPid(100, ctx)?.id, 'api', 'command-line match');
  assert.equal(projectForPid(202, ctx)?.id, 'web', 'ancestor cwd, deepest project wins over mono');
  assert.equal(projectForPid(400, ctx)?.id, 'mono', 'cwd inside mono but not inside web');
  assert.equal(projectForPid(300, ctx), null, '/code/api-old is not inside /code/api');
  assert.equal(projectForPid(null, ctx), null);
  assert.equal(projectForPid(999, ctx), null);
  // Order of projects in the input must not matter.
  assert.equal(projectForPid(202, { ...ctx, projects: [web, mono, api].reverse() })?.id, 'web');
});

test('ports: buildPortTable fills project/service and flags unknown', () => {
  const web = proj('web', '/Users/me/code/web', [{ name: 'dev', port: 3000 }]);
  const processes = new Map<number, ProcessInfo>([[10, proc(10, 1, 'node', 'node /Users/me/code/web/node_modules/.bin/next dev')], [20, proc(20, 1, 'postgres', '/usr/lib/postgres')]]);
  const cwds = new Map<number, string>([[10, '/Users/me/code/web']]);
  const table = buildPortTable([portInfo(3000, 10, '127.0.0.1'), portInfo(5432, 20, '*', 'postgres'), portInfo(8080, null, '0.0.0.0')], { processes, cwds, projects: [web] });
  assert.equal(table.length, 3);
  assert.deepEqual(table[0], {
    port: 3000, address: '127.0.0.1', exposure: 'loopback', pid: 10, processName: 'node', command: 'node /Users/me/code/web/node_modules/.bin/next dev',
    cwd: '/Users/me/code/web', projectId: 'web', projectName: 'web', serviceId: 'web:s0', serviceName: 'dev', unknown: false,
  });
  assert.equal(table[1].unknown, true);
  assert.equal(table[1].exposure, 'network');
  assert.equal(table[1].processName, 'postgres');
  assert.equal(table[2].pid, null);
  assert.equal(table[2].cwd, null);
  assert.equal(table[2].unknown, true);
});

test('ports: findConflicts', () => {
  const a = proj('a', '/Users/me/a', [{ name: 'web', port: 3000 }, { name: 'api', port: 4000 }, { name: 'free', port: 5000 }, { name: 'noport', port: null }]);
  const b = proj('b', '/Users/me/b', [{ name: 'web', port: 3001 }]);
  const table = [
    entry({ port: 3000, pid: 77, processName: 'node', projectId: 'b', projectName: 'b', command: 'node b', unknown: false }),
    entry({ port: 4000, pid: 88, processName: 'node', projectId: 'a', projectName: 'a', unknown: false }),
    entry({ port: 3001, pid: 99, processName: 'java' }),
  ];
  const conflicts = findConflicts(table, [a, b]);
  assert.deepEqual(conflicts, [
    { port: 3000, usedBy: { pid: 77, processName: 'node', projectName: 'b', command: 'node b' }, requestedBy: { projectId: 'a', projectName: 'a', serviceId: 'a:s0', serviceName: 'web' } },
    { port: 3001, usedBy: { pid: 99, processName: 'java', projectName: null, command: null }, requestedBy: { projectId: 'b', projectName: 'b', serviceId: 'b:s0', serviceName: 'web' } },
  ]);
  assert.deepEqual(findConflicts([], [a, b]), []);
});

/* ── 5. Environment ── */
test('env: parseEnv handles export, quotes, comments, CRLF', () => {
  const env = parseEnv([
    '# comment', '', 'export API_URL=http://localhost:4000', 'NAME="Dev NEX"', "SINGLE='a # b'", 'PLAIN=value # trailing comment',
    'HASH=abc#def', 'EMPTY=', '  SPACED  =  padded  ', 'not a line', '1BAD=x', 'DOTTED.KEY-x=1', 'EQ=a=b=c', 'WIN=crlf\r', 'LAST=end',
  ].join('\r\n'));
  assert.deepEqual(Object.fromEntries(env), {
    API_URL: 'http://localhost:4000', NAME: 'Dev NEX', SINGLE: 'a # b', PLAIN: 'value', HASH: 'abc#def', EMPTY: '',
    SPACED: 'padded', 'DOTTED.KEY-x': '1', EQ: 'a=b=c', WIN: 'crlf', LAST: 'end',
  });
});

test('env: parseEnv strips quotes when a quoted value has an inline comment', () => {
  assert.equal(parseEnv('KEY="value" # comment').get('KEY'), 'value');
});

test('env: maskValue', () => {
  assert.equal(maskValue('API_KEY', 'sk-live-abcdef8Jx'), 'sk-****8Jx');
  assert.equal(maskValue('JWT_SECRET', 'short'), '****');
  assert.equal(maskValue('DB_PASSWORD', '123456789'), '****');
  assert.equal(maskValue('DATABASE_URL', 'postgres://admin:hunter2pass@db.local:5432/app'), 'postgres://****:****@db.local:5432/app');
  assert.equal(maskValue('REDIS_URL', 'redis://localhost:6379'), 'redis://localhost:6379');
  assert.equal(maskValue('PORT', '3000'), '3000');
  assert.equal(maskValue('NODE_ENV', 'development'), 'development');
  assert.equal(maskValue('API_KEY', ''), '');
  const long = 'x'.repeat(60);
  assert.equal(maskValue('DESCRIPTION', long), `${'x'.repeat(45)}…`);
});

test('env: inspectEnvironment compares example vs .env/.env.local and never leaks secrets', () => {
  const SECRETS = ['sk-live-REALSECRET123', 'pk-overridden-secret-999', 'hunter2pass', 'tiny', 'ghp_extraTokenValue42'];
  const d = tree(tmp(), {
    '.env.example': 'PORT=3000\nAPI_KEY=\nDATABASE_URL=\nSTRIPE_SECRET=\nMISSING_ONE=\nEMPTY_ONE=\nSHORT_TOKEN=\n',
    '.env': 'PORT=3100\nAPI_KEY=sk-live-REALSECRET123\nSTRIPE_SECRET=pk-will-be-overridden\nEMPTY_ONE=\nSHORT_TOKEN=tiny\n',
    '.env.local': 'STRIPE_SECRET=pk-overridden-secret-999\nDATABASE_URL=postgres://admin:hunter2pass@localhost:5432/app\nGITHUB_TOKEN=ghp_extraTokenValue42\nDEBUG=true\n',
  });
  const r = inspectEnvironment('proj', d);
  assert.equal(r.projectId, 'proj');
  assert.equal(r.expectedFrom, '.env.example');
  assert.deepEqual(r.files, ['.env', '.env.local']);
  const byKey = Object.fromEntries(r.rows.map(x => [x.key, x]));
  assert.deepEqual(byKey.PORT, { key: 'PORT', status: 'configured', preview: '3100', sensitive: false, source: '.env' });
  assert.deepEqual(byKey.API_KEY, { key: 'API_KEY', status: 'configured', preview: 'sk-****123', sensitive: true, source: '.env' });
  assert.equal(byKey.STRIPE_SECRET.source, '.env.local');
  assert.equal(byKey.STRIPE_SECRET.preview, 'pk-****999');
  assert.equal(byKey.DATABASE_URL.preview, 'postgres://****:****@localhost:5432/app');
  assert.equal(byKey.DATABASE_URL.sensitive, true);
  assert.deepEqual(byKey.MISSING_ONE, { key: 'MISSING_ONE', status: 'missing', preview: null, sensitive: false, source: null });
  assert.equal(byKey.EMPTY_ONE.status, 'empty');
  assert.equal(byKey.SHORT_TOKEN.preview, '****');
  assert.equal(byKey.GITHUB_TOKEN.status, 'extra');
  assert.equal(byKey.GITHUB_TOKEN.sensitive, true);
  assert.equal(byKey.DEBUG.status, 'extra');
  assert.equal(r.missing, 2);
  assert.equal(r.configured, 5);
  assert.equal(r.rows.length, 9);
  const json = JSON.stringify(r);
  for (const s of SECRETS) assert.ok(!json.includes(s), `raw secret leaked: ${s}`);
});

test('env: no example file → only extras; no files at all → empty report', () => {
  const d = tree(tmp(), { '.env.development': 'A=1\n' });
  const r = inspectEnvironment('p', d);
  assert.equal(r.expectedFrom, null);
  assert.deepEqual(r.rows.map(x => [x.key, x.status]), [['A', 'extra']]);
  assert.deepEqual(inspectEnvironment('p', tmp()), { projectId: 'p', files: [], expectedFrom: null, rows: [], missing: 0, configured: 0 });
});

/* ── 6. Runtime ── */
test('runtime: parseVersion', () => {
  assert.deepEqual(parseVersion('v22.12.0'), [22, 12, 0]);
  assert.deepEqual(parseVersion('10.4.1'), [10, 4, 1]);
  assert.deepEqual(parseVersion('22'), [22, 0, 0]);
  assert.deepEqual(parseVersion('Docker version 27.3.1, build ce12230'), [27, 3, 1]);
  assert.equal(parseVersion('lts/*'), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test('runtime: satisfies', () => {
  const cases: [string, string, boolean | null][] = [
    ['22.12.0', '22', true], ['20.1.0', '22', false],
    ['22.12.0', '22.x', true], ['21.9.0', '22.x', false],
    ['22.1.5', '22.1.x', true], ['22.2.0', '22.1.x', false],
    ['22.12.0', '>=20', true], ['18.20.0', '>=20', false], ['20.0.0', '>=20', true],
    ['20.11.1', '>=18 <21', true], ['21.0.0', '>=18 <21', false], ['16.0.0', '>=18 <21', false],
    ['22.5.0', '^22.1.0', true], ['22.0.9', '^22.1.0', false], ['23.0.0', '^22.1.0', false],
    ['22.1.9', '~22.1', true], ['22.2.0', '~22.1', false], ['22.0.0', '~22.1', false],
    ['20.5.0', '20 || 22', true], ['22.0.0', '20 || 22', true], ['21.0.0', '20 || 22', false],
    ['v22.12.0', '>=v20.0.0', true], ['22.0.0', '*', true],
    ['22.12.0', 'lts/*', null], ['22.12.0', 'node', null], ['22.12.0', '', null], ['garbage', '22', null],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `satisfies(${v}, ${r})`);
});

test('runtime: checkRuntimes from engines, packageManager and .nvmrc', () => {
  const tools = [{ name: 'node' as const, version: '22.12.0' }, { name: 'npm' as const, version: '10.9.0' }, { name: 'pnpm' as const, version: null }, { name: 'yarn' as const, version: '1.22.22' }];
  const engines = tree(tmp(), { 'package.json': { engines: { node: '>=18 <21', npm: '>=10', vscode: '^1.80.0' }, packageManager: 'pnpm@9.1.0' }, '.nvmrc': 'v22' });
  assert.deepEqual(checkRuntimes(engines, tools), [
    { tool: 'node', required: '>=18 <21', source: 'package.json engines', installed: '22.12.0', status: 'mismatch' },
    { tool: 'npm', required: '>=10', source: 'package.json engines', installed: '10.9.0', status: 'ok' },
    { tool: 'pnpm', required: '9.1.0', source: 'package.json packageManager', installed: null, status: 'missing' },
  ]);
  const nvm = tree(tmp(), { 'package.json': { packageManager: 'yarn@1.22.0' }, '.nvmrc': 'v22\n' });
  assert.deepEqual(checkRuntimes(nvm, tools), [
    { tool: 'yarn', required: '1.22.0', source: 'package.json packageManager', installed: '1.22.22', status: 'ok' },
    { tool: 'node', required: '22', source: '.nvmrc', installed: '22.12.0', status: 'ok' },
  ]);
  const old = tree(tmp(), { '.node-version': '20.11.0' });
  assert.equal(checkRuntimes(old, tools)[0].status, 'mismatch');
  const lts = tree(tmp(), { '.nvmrc': 'lts/*' });
  assert.equal(checkRuntimes(lts, tools)[0].status, 'unknown');
  assert.deepEqual(checkRuntimes(tmp(), tools), []);
});

/* ── 7. Git ── */
test('git: parseGitStatus', () => {
  assert.deepEqual(parseGitStatus('## main...origin/main [ahead 3, behind 1]\n M src/a.ts\nMM src/b.ts\nA  new.ts\n?? scratch.txt\n?? tmp/\n'), {
    branch: 'main', upstream: 'origin/main', ahead: 3, behind: 1, changed: 3, untracked: 2,
  });
  assert.deepEqual(parseGitStatus('## main...origin/main [behind 7]\n'), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 7, changed: 0, untracked: 0 });
  assert.deepEqual(parseGitStatus('## feature/x\n D old.ts\n'), { branch: 'feature/x', upstream: null, ahead: 0, behind: 0, changed: 1, untracked: 0 });
  assert.deepEqual(parseGitStatus('## feature/x...origin/feature/x\n'), { branch: 'feature/x', upstream: 'origin/feature/x', ahead: 0, behind: 0, changed: 0, untracked: 0 });
  assert.deepEqual(parseGitStatus('## No commits yet on main\n?? README.md\n'), { branch: 'main', upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 1 });
  assert.deepEqual(parseGitStatus('## HEAD (no branch)\n M x\n'), { branch: 'detached HEAD', upstream: null, ahead: 0, behind: 0, changed: 1, untracked: 0 });
  assert.deepEqual(parseGitStatus(''), { branch: null, upstream: null, ahead: 0, behind: 0, changed: 0, untracked: 0 });
});

/* ── 8. Docker ── */
test('docker: parseDockerPs parses JSON lines, compose labels, skips malformed', () => {
  const lines = [
    JSON.stringify({ ID: 'abc123', Names: 'shop-db-1', Image: 'postgres:16', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:5432->5432/tcp',
      Labels: 'com.docker.compose.project=shop,com.docker.compose.project.working_dir=/Users/me/code/shop,com.docker.compose.service=db,desc=a=b' }),
    '{not json',
    JSON.stringify({ ID: 'def456', Names: 'scratch', Image: 'alpine', State: 'Exited', Status: 'Exited (1) 5 minutes ago', Ports: '' }),
    '',
  ].join('\n');
  const cs = parseDockerPs(lines);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0], {
    id: 'abc123', name: 'shop-db-1', image: 'postgres:16', state: 'running', status: 'Up 2 hours', ports: '0.0.0.0:5432->5432/tcp',
    composeProject: 'shop', workingDir: '/Users/me/code/shop', projectId: null,
  });
  assert.equal(cs[1].state, 'exited');
  assert.equal(cs[1].composeProject, null);
  assert.equal(cs[1].workingDir, null);
  assert.deepEqual(parseDockerPs(''), []);
});

test('docker: dockerInfo resolves with a well-formed result', async () => {
  const info = await dockerInfo();
  assert.equal(typeof info.available, 'boolean');
  assert.ok(Array.isArray(info.containers));
  if (info.available) assert.equal(info.detail, null);
  else { assert.equal(typeof info.detail, 'string'); assert.deepEqual(info.containers, []); }
});

/* ── 9. Health rules ── */
const container = (o: Partial<Container> & { id: string }): Container =>
  ({ name: o.id, image: 'img', state: 'exited', status: 'Exited (0) 1 hour ago', ports: '', composeProject: null, workingDir: null, projectId: null, ...o });
const envReport = (rows: EnvReport['rows']): EnvReport =>
  ({ projectId: 'shop', files: ['.env'], expectedFrom: '.env.example', rows, missing: rows.length, configured: 0 });
const healthInput = (o: Partial<HealthInput>): HealthInput =>
  ({ projects: [], conflicts: [], ports: [], processes: new Map(), env: new Map(), runtime: new Map(), containers: [], ...o });

test('health: every rule fires with the right severity, sorted critical → warning → info', () => {
  const shop = proj('shop', '/Users/me/shop', [
    { name: 'api', port: 4000, status: 'FAILED', exitCode: 1 },
    { name: 'web', port: 3000, status: 'RUNNING' },
  ]);
  const mismatch: RuntimeCheck = { tool: 'node', required: '20', installed: '22.12.0', source: '.nvmrc', status: 'mismatch' };
  const okCheck: RuntimeCheck = { tool: 'npm', required: '>=10', installed: '10.9.0', source: 'package.json engines', status: 'ok' };
  const issues = evaluateHealth(healthInput({
    projects: [shop],
    conflicts: [{ port: 3000, usedBy: { pid: 77, processName: 'node', projectName: 'other', command: null }, requestedBy: { projectId: 'shop', projectName: 'shop', serviceId: 'shop:s1', serviceName: 'web' } }],
    ports: [
      entry({ port: 5173, pid: 500, address: '0.0.0.0', exposure: 'network', projectId: 'shop', projectName: 'shop', unknown: false }), // orphan + exposed
      entry({ port: 8000, pid: 600, address: '127.0.0.1', projectId: 'shop', projectName: 'shop', unknown: false }), // not orphan (ppid 42)
      entry({ port: 7000, pid: 700, address: '*', exposure: 'network' }), // AirPlay: not a dev runtime → nothing
    ],
    processes: new Map([[500, proc(500, 1, 'node')], [600, proc(600, 42, 'python3')], [700, proc(700, 1, 'ControlCenter')]]),
    env: new Map([['shop', envReport([
      { key: 'API_KEY', status: 'missing', preview: null, sensitive: true, source: null },
      { key: 'DB_URL', status: 'empty', preview: '', sensitive: false, source: '.env' },
      { key: 'PORT', status: 'configured', preview: '3000', sensitive: false, source: '.env' },
    ])]]),
    runtime: new Map([['shop', [mismatch, okCheck]]]),
    containers: [
      container({ id: 'c1', name: 'shop-db', status: 'Exited (137) 2 minutes ago' }),
      container({ id: 'c2', name: 'migrate', status: 'Exited (0) 1 hour ago' }),
      container({ id: 'c3', name: 'redis', state: 'running', status: 'Up 1 hour' }),
    ],
  }));
  const ids = issues.map(i => `${i.severity}:${i.id}`);
  assert.deepEqual(ids, [
    'critical:conflict:3000:shop:s1',
    'critical:crash:shop:s0',
    'warning:env:shop',
    'warning:runtime:shop:node',
    'warning:container:c1',
    'warning:orphan:500',
    'info:exposed:5173',
  ]);
  const byId = Object.fromEntries(issues.map(i => [i.id, i]));
  assert.equal(byId['conflict:3000:shop:s1'].port, 3000);
  assert.equal(byId['conflict:3000:shop:s1'].pid, 77);
  assert.match(byId['conflict:3000:shop:s1'].description, /held by node \(PID 77\) from other/);
  assert.match(byId['crash:shop:s0'].description, /exited with code 1/);
  assert.equal(byId['env:shop'].title, '2 environment variables missing');
  assert.match(byId['env:shop'].description, /API_KEY, DB_URL are in \.env\.example/);
  assert.equal(byId['runtime:shop:node'].title, 'Runtime version mismatch');
  assert.equal(byId['orphan:500'].pid, 500);
  for (const i of issues) {
    assert.ok(i.title && i.description && i.reason && i.recommendedAction, `issue ${i.id} is fully explained`);
  }
});

test('health: quiet system → no issues; WARNING / memory / database rules', () => {
  assert.deepEqual(evaluateHealth(healthInput({ projects: [proj('ok', '/Users/me/ok', [{ name: 'web', status: 'RUNNING', port: 3000 }])] })), []);
  const p = proj('p', '/Users/me/p', [
    { name: 'web', status: 'WARNING', detail: 'Port 3000 never opened.' },
    { name: 'api', status: 'RUNNING', memoryBytes: 2 * 1024 ** 3, pid: 9 },
    { name: 'postgres', type: 'database', port: 5432, status: 'STOPPED' },
    { name: 'redis-db', type: 'database', port: 6379, status: 'STOPPED' }, // something listens → fine
  ]);
  const issues = evaluateHealth(healthInput({ projects: [p], ports: [entry({ port: 6379, pid: 3 })] }));
  assert.deepEqual(issues.map(i => i.id), ['warn:p:s0', 'mem:p:s1', 'db:p:s2']);
  assert.equal(issues[1].title, 'api uses 2.0 GB');
});

test('health: missing runtime tool is a warning, single missing env var uses singular', () => {
  const p = proj('p', '/Users/me/p');
  const issues = evaluateHealth(healthInput({
    projects: [p],
    env: new Map([['p', envReport([{ key: 'SECRET', status: 'missing', preview: null, sensitive: true, source: null }])]]),
    runtime: new Map([['p', [{ tool: 'pnpm', required: '9.1.0', installed: null, source: 'package.json packageManager', status: 'missing' }]]]),
  }));
  assert.equal(issues[0].title, '1 environment variable missing');
  assert.match(issues[0].description, /SECRET is in/);
  assert.equal(issues[1].title, 'pnpm is not installed');
});

/* ── 10. Log levels ── */
test('logs: levelOf', () => {
  assert.equal(levelOf('Error: Cannot find module "x"', 'stdout'), 'error');
  assert.equal(levelOf('Error: listen EADDRINUSE: address already in use :::3000', 'stderr'), 'error');
  assert.equal(levelOf('connect ECONNREFUSED 127.0.0.1:5432', 'stdout'), 'error');
  assert.equal(levelOf('UnhandledPromiseRejection', 'stdout'), 'info', 'no word boundary inside the identifier');
  assert.equal(levelOf('Unhandled promise rejection', 'stdout'), 'error');
  assert.equal(levelOf('Build failed with 2 errors', 'stdout'), 'error');
  assert.equal(levelOf('FATAL ERROR: Reached heap limit', 'stdout'), 'error');
  assert.equal(levelOf('warn - Fast Refresh had to perform a full reload', 'stdout'), 'warning');
  assert.equal(levelOf('(node:1) [DEP0040] DeprecationWarning: The punycode module is deprecated.', 'stderr'), 'warning');
  assert.equal(levelOf('Compiled successfully in 1.2s', 'stdout'), 'info');
  assert.equal(levelOf('  ➜  Local:   http://localhost:5173/', 'stderr'), 'warning', 'any stderr text is at least a warning');
  assert.equal(levelOf('   ', 'stderr'), 'info');
  assert.equal(levelOf('ready on http://localhost:3000', 'stdout'), 'info');
});

test('logs: levelOf detects npm "ERR!" lines as errors', () => {
  assert.equal(levelOf('npm ERR! missing script: dev', 'stdout'), 'error');
  assert.equal(levelOf('npm ERR! code ELIFECYCLE', 'stderr'), 'error');
});

/* ── Start refusal message (never auto-kills; names the owner) ── */
test('conflict message: says who owns the port and that nothing was stopped', () => {
  const msg = conflictMessage({
    port: 3000,
    usedBy: { pid: 18342, processName: 'node', projectName: 'old-test-project', command: 'node server.js' },
    requestedBy: { projectId: 'p', projectName: 'SmartFlowNEX', serviceId: 'p:frontend', serviceName: 'frontend' },
  });
  assert.match(msg, /^Cannot start frontend\. Port 3000 is already in use\./);
  assert.match(msg, /Owner: node · PID 18342 · Project: old-test-project/);
  assert.match(msg, /Nothing was stopped/);
  const unknown = conflictMessage({ port: 5432, usedBy: { pid: null, processName: null, projectName: null, command: null }, requestedBy: { projectId: 'p', projectName: 'X', serviceId: 'p:db', serviceName: 'db' } });
  assert.match(unknown, /unknown process · not tied to a known project/);
});
