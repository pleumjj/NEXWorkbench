import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortInfo, ProcessInfo } from '@nex/shared';
import { detectAgent, maskCommand } from '@nex/process-core';
import { AgentTracker, IDLE_AFTER, type Snapshot, type ViewContext } from '../agent-engine';

const T0 = Date.parse('2026-11-17T09:00:00Z');
const MIN = 60_000;
const proc = (pid: number, ppid: number, name: string, command: string, startedAt: number, extra: Partial<ProcessInfo> = {}): ProcessInfo =>
  ({ pid, ppid, name, command, cpu: 0, memory: 100 * 1024 ** 2, user: 'me', startedAt, ...extra });
const port = (p: number, pid: number): PortInfo => ({ port: p, address: '127.0.0.1', pid, processName: null, protocol: 'tcp' });
const snap = (now: number, processes: ProcessInfo[], ports: PortInfo[] = [], cwds: Record<number, string> = {}): Snapshot =>
  ({ now, processes, ports, cwds: new Map(Object.entries(cwds).map(([k, v]) => [Number(k), v])) });
const ctx: ViewContext = { projects: [{ id: 'shop', name: 'shop-app', path: '/u/shop-app' }], blockedReason: p => (p.name === 'launchd' ? 'System protected.' : null) };

const VSCODE = proc(10, 1, 'Code Helper', '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', T0 - 60 * MIN);
const CLAUDE = proc(100, 10, 'claude', '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.325-darwin-arm64/resources/native-binary/claude --output-format stream-json', T0, { cpu: 20 });
const ZSH = proc(101, 100, 'zsh', '/bin/zsh -c npm run dev', T0 + MIN);
const NPM = proc(102, 101, 'npm', 'npm run dev', T0 + MIN);
const NEXT = proc(103, 102, 'node', 'node /u/shop-app/node_modules/.bin/next dev', T0 + MIN, { memory: 900 * 1024 ** 2 });

test('agents · detection by executable or runtime script (never the desktop app or wrappers)', () => {
  assert.equal(detectAgent(CLAUDE), 'claude-code');
  assert.equal(detectAgent({ name: 'claude', command: '/Users/me/Library/Application Support/Claude/claude-code/2.1.325/x/claude.app/Contents/MacOS/claude --output-format stream-json' }), 'claude-code');
  assert.equal(detectAgent({ name: 'Claude', command: '/Applications/Claude.app/Contents/MacOS/Claude' }), null, 'the Claude desktop app is not an agent session');
  assert.equal(detectAgent({ name: 'disclaimer', command: '/Applications/Claude.app/Contents/Helpers/disclaimer -- …/claude --output' }), null);
  assert.equal(detectAgent({ name: 'node', command: 'node /usr/local/bin/claude' }), 'claude-code');
  assert.equal(detectAgent({ name: 'node', command: 'node /x/lib/node_modules/@anthropic-ai/claude-code/cli.js' }), 'claude-code');
  assert.equal(detectAgent({ name: 'codex', command: '/Users/me/.vscode/extensions/openai.chatgpt/bin/codex app-server' }), 'codex');
  assert.equal(detectAgent({ name: 'Python', command: 'Python /opt/homebrew/bin/aider --model x' }), 'aider');
  assert.equal(detectAgent({ name: 'node', command: 'node /u/shop-app/node_modules/.bin/next dev' }), null);
});

test('agents · secrets in command lines are masked', () => {
  const m = maskCommand('aider --api-key sk-ant-123 --openai-api-key=sk-456 ANTHROPIC_API_KEY=abc https://user:pw@host/x');
  assert.ok(!/sk-ant-123|sk-456|abc|pw@/.test(m), m);
});

test('agents · lineage: a dev server outlives its agent → leftover with its port, memory and the session it came from', () => {
  const t = new AgentTracker();
  t.observe(snap(T0 + 2 * MIN, [VSCODE, CLAUDE, ZSH, NPM, NEXT], [port(3000, 103)], { 100: '/u/shop-app' }));
  let v = t.view(snap(T0 + 2 * MIN, [VSCODE, CLAUDE, ZSH, NPM, NEXT], [port(3000, 103)]), ctx);
  assert.equal(v.sessions.length, 1);
  const s = v.sessions[0];
  assert.equal(s.toolName, 'Claude Code');
  assert.equal(s.host, 'VS Code');
  assert.equal(s.projectName, 'shop-app');
  assert.equal(s.state, 'working');
  assert.deepEqual(s.ports.map(p => p.port), [3000]);
  assert.equal(s.servers.length, 1, 'the dev server it started');
  assert.equal(v.findings.length, 0, 'nothing left behind while the agent runs');

  // The agent and its shell exit; npm and next are re-parented to launchd.
  const later = [VSCODE, { ...NPM, ppid: 1 }, NEXT];
  t.observe(snap(T0 + 30 * MIN, later, [port(3000, 103)]));
  v = t.view(snap(T0 + 30 * MIN, later, [port(3000, 103)]), ctx);
  const ended = v.sessions[0];
  assert.equal(ended.state, 'ended');
  assert.equal(ended.leftovers.length, 1, 'one top-level leftover (npm), next is inside it');
  assert.equal(ended.leftovers[0].pid, 102);
  assert.deepEqual(ended.leftovers[0].ports, [3000]);
  assert.equal(ended.leftovers[0].memoryBytes, 1000 * 1024 ** 2);
  assert.equal(v.findings[0].kind, 'leftovers');
  assert.match(v.findings[0].title, /1 process left by Claude Code · shop-app/);
  assert.equal(v.summary.leftoverProcesses, 1);
  assert.deepEqual(v.summary.leftoverPorts, [3000]);
  assert.deepEqual(t.sessionOf(NEXT, later)?.id, ended.id, 'ports can say which agent started them');
});

test('agents · a reused PID (different start time) is never treated as a leftover', () => {
  const t = new AgentTracker();
  t.observe(snap(T0 + 2 * MIN, [CLAUDE, ZSH, NPM, NEXT], [], { 100: '/u/shop-app' }));
  const reused = [proc(102, 1, 'npm', 'npm run dev', T0 + 40 * MIN), proc(103, 50, 'node', 'node other.js', T0 + 40 * MIN)];
  t.observe(snap(T0 + 41 * MIN, reused));
  const v = t.view(snap(T0 + 41 * MIN, reused), ctx);
  assert.equal(v.sessions.length, 0, 'ended session with nothing of its own still running is not shown');
  assert.equal(v.findings.length, 0);
  const targets = t.leftoverTargets([...t.sessions.keys()][0], [102, 103], snap(T0 + 41 * MIN, reused), ctx);
  assert.equal(targets.stop.length, 0, 'and can never be stopped through the session');
});

test('agents · a process started in the background (re-parented at once) is matched by folder and start time', () => {
  const t = new AgentTracker();
  const bg = proc(200, 1, 'node', 'node server.js', T0 + 5 * MIN);
  const elsewhere = proc(201, 1, 'node', 'node other.js', T0 + 5 * MIN);
  const before = proc(202, 1, 'node', 'node old.js', T0 - 10 * MIN);
  t.observe(snap(T0 + 6 * MIN, [CLAUDE, bg, elsewhere, before], [port(4000, 200)], { 100: '/u/shop-app', 200: '/u/shop-app/api', 201: '/u/other', 202: '/u/shop-app' }));
  t.observe(snap(T0 + 20 * MIN, [bg, elsewhere, before], [port(4000, 200)], { 200: '/u/shop-app/api', 201: '/u/other', 202: '/u/shop-app' }));
  const v = t.view(snap(T0 + 20 * MIN, [bg, elsewhere, before], [port(4000, 200)]), ctx);
  assert.deepEqual(v.sessions[0].leftovers.map(l => [l.pid, l.how]), [[200, 'inferred']], 'only the process started in its folder while it ran');
});

test('agents · working → waiting for you after 10 quiet minutes; a nested agent is part of its parent session', () => {
  const t = new AgentTracker();
  const codexChild = proc(110, 100, 'codex', 'codex exec', T0 + MIN);
  t.observe(snap(T0 + MIN, [CLAUDE, codexChild], [], { 100: '/u/shop-app' }));
  const quiet = [{ ...CLAUDE, cpu: 0 }, { ...codexChild, cpu: 0 }];
  t.observe(snap(T0 + MIN + IDLE_AFTER + MIN, quiet));
  const v = t.view(snap(T0 + MIN + IDLE_AFTER + MIN, quiet), ctx);
  assert.equal(v.sessions.length, 1, 'codex started by Claude Code is not a second session');
  assert.equal(v.sessions[0].state, 'waiting');
  assert.equal(v.summary.waiting, 1);
});

test('agents · a running agent’s processes and protected processes are never stop targets', () => {
  const t = new AgentTracker();
  t.observe(snap(T0 + 2 * MIN, [CLAUDE, ZSH, NPM, NEXT], [], { 100: '/u/shop-app' }));
  const id = [...t.sessions.keys()][0];
  const running = t.leftoverTargets(id, [102], snap(T0 + 3 * MIN, [CLAUDE, ZSH, NPM, NEXT]), ctx);
  assert.equal(running.stop.length, 0);
  assert.match(running.refused[0].reason, /still running/);
  // Ended: the leftover can be stopped; a protected one is refused with its reason.
  const after = [{ ...NPM, ppid: 1 }, NEXT];
  t.observe(snap(T0 + 30 * MIN, after));
  const ok = t.leftoverTargets(id, [102], snap(T0 + 30 * MIN, after), ctx);
  assert.deepEqual(ok.stop.map(p => p.pid), [102]);
  const strict: ViewContext = { ...ctx, blockedReason: p => (p.pid === 102 ? 'npm is protected in MemNEX settings.' : null) };
  const refused = t.leftoverTargets(id, [102], snap(T0 + 30 * MIN, after), strict);
  assert.equal(refused.stop.length, 0);
  assert.match(refused.refused[0].reason, /protected/);
});

test('agents · state survives a NEX restart (lineage is persisted)', () => {
  const t = new AgentTracker();
  t.observe(snap(T0 + 2 * MIN, [CLAUDE, ZSH, NPM, NEXT], [], { 100: '/u/shop-app' }));
  const restored = new AgentTracker(JSON.parse(JSON.stringify(t.toJSON())));
  const after = [{ ...NPM, ppid: 1 }, NEXT];
  restored.observe(snap(T0 + 30 * MIN, after));
  assert.equal(restored.view(snap(T0 + 30 * MIN, after), ctx).summary.leftoverProcesses, 1);
});

test('agents · two agents starting the same project’s dev server are called out', () => {
  const t = new AgentTracker();
  const c2 = proc(300, 10, 'claude', CLAUDE.command, T0 + 3 * MIN);
  const s2 = proc(301, 300, 'node', 'node next dev -p 3001', T0 + 4 * MIN);
  const all = [CLAUDE, ZSH, NPM, NEXT, c2, s2];
  t.observe(snap(T0 + 5 * MIN, all, [port(3000, 103), port(3001, 301)], { 100: '/u/shop-app', 300: '/u/shop-app' }));
  const v = t.view(snap(T0 + 5 * MIN, all, [port(3000, 103), port(3001, 301)]), ctx);
  const dup = v.findings.find(f => f.kind === 'duplicate-servers');
  assert.ok(dup);
  assert.deepEqual(dup.ports, [3000, 3001]);
});

test('agents · ps start-time jitter (±1 s) never splits one agent into two sessions; a root folder never claims processes', () => {
  const t = new AgentTracker();
  t.observe(snap(T0 + MIN, [CLAUDE], [], { 100: '/u/shop-app' }));
  t.observe(snap(T0 + 2 * MIN, [{ ...CLAUDE, startedAt: CLAUDE.startedAt! + 1000 }]));
  t.observe(snap(T0 + 3 * MIN, [{ ...CLAUDE, startedAt: CLAUDE.startedAt! - 1000 }]));
  assert.equal(t.sessions.size, 1);
  // Older duplicates (saved before this fix) are merged.
  const dupes = new AgentTracker([...t.toJSON(), { ...t.toJSON()[0], id: 'dupe', startedAt: CLAUDE.startedAt! + 1000, firstSeenAt: T0 + 5 * MIN }]);
  dupes.observe(snap(T0 + 6 * MIN, [CLAUDE]));
  assert.equal(dupes.sessions.size, 1);

  const app = proc(400, 10, 'codex', 'codex app-server', T0);
  const stranger = proc(401, 1, 'node', 'node mine.js', T0 + 2 * MIN);
  const r = new AgentTracker();
  r.observe(snap(T0 + MIN, [app], [], { 400: '/' }));
  r.observe(snap(T0 + 3 * MIN, [app, stranger], [], { 401: '/Users/me/work' }));
  r.observe(snap(T0 + 9 * MIN, [stranger], [], { 401: '/Users/me/work' }));
  assert.equal(r.view(snap(T0 + 9 * MIN, [stranger]), ctx).summary.leftoverProcesses, 0, 'a process of yours is not claimed by an agent running from /');
});
