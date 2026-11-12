import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryReading, ProcessInfo } from '@nex/shared';
import { groupProcesses, type ClassifyOptions } from '@nex/process-core';
import { assessHealth } from '../memory-engine/health';
import { MemoryGrowth } from '../memory-engine/growth';
import { ActivityTracker } from '../recommendation-engine/activity';
import { recommend } from '../recommendation-engine/recommend';
import { diagnose } from '../recommendation-engine/diagnosis';
import { PreferenceStore, KEPT_OPEN_LIMIT } from '../protection-engine/preferences';
import { assertControllable, protectionFor } from '../protection-engine/protection';
import { buildPreview, summarizeCleanup } from '../cleanup-engine/cleanup';
import { ReopenRegistry } from '../cleanup-engine/reopen';
import { MemnexError } from '../errors';
import type { AppSummary, Health, Snapshot } from '../types';

const MIN = 60_000, MB = 1024 ** 2, GB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const mem = (o: Partial<MemoryReading>): MemoryReading => ({ total: 16 * GB, used: 8 * GB, available: 8 * GB, compressed: 0, cached: 0, swap: { total: 0, used: 0 }, swapOutBytes: 0, pressure: null, ...o });
const proc = (pid: number, app: string, mb: number, cpu = 0, ppid = 1): ProcessInfo =>
  ({ pid, ppid, name: app, command: `/Applications/${app}.app/Contents/MacOS/${app}`, cpu, memory: mb * MB, user: 'me' });
const CLASSIFY: ClassifyOptions = { selfRoot: '/nex-root', selfPid: 9999, systemName: 'macOS system services' };

/* ── Memory Health Engine ── */
test('health: macOS pressure wins over RAM %', () => {
  assert.equal(assessHealth(mem({ used: 15 * GB, pressure: 'normal' }), 0).state, 'Moderate');
  assert.equal(assessHealth(mem({ used: 6 * GB, pressure: 'normal' }), 0).state, 'Healthy');
  assert.equal(assessHealth(mem({ pressure: 'warn' }), 0).state, 'High');
  assert.equal(assessHealth(mem({ pressure: 'critical' }), 0).state, 'Critical');
});
test('health: active swapping (not existing swap) raises state', () => {
  assert.equal(assessHealth(mem({ pressure: 'normal', swap: { total: 8 * GB, used: 7 * GB } }), 0).state, 'Healthy');
  const h = assessHealth(mem({ pressure: 'normal' }), 5 * MB);
  assert.equal(h.state, 'High');
  assert.equal(h.swapRising, true);
});
test('health: without OS pressure, falls back to thresholds', () => {
  assert.equal(assessHealth(mem({ used: 10 * GB }), null).state, 'Healthy');
  assert.equal(assessHealth(mem({ used: 12 * GB }), null).state, 'Moderate');
  assert.equal(assessHealth(mem({ used: 14 * GB }), null).state, 'High');
  assert.equal(assessHealth(mem({ used: 15.5 * GB }), 5 * MB).state, 'Critical');
});

/* ── Recommendations (idle apps, not big apps) ── */
function scenario(health: Health, muted: string[] = []) {
  const act = new ActivityTracker(null, NOW - 90 * MIN);
  act.setState({ coverageStart: NOW - 90 * MIN, lastActive: { 'com.chat': NOW - 45 * MIN, 'com.code': NOW - 3 * MIN } }, { key: 'com.browser', pid: 300, present: true });
  const procs = [proc(100, 'Chat', 800), proc(200, 'Code', 2000, 1), proc(300, 'Browser', 1500, 3), proc(400, 'Mail', 600), proc(500, 'Sync', 900, 12), proc(600, 'Tiny', 50)];
  const ids = new Map(['Chat', 'Code', 'Browser', 'Mail', 'Sync', 'Tiny'].map(n => [`/Applications/${n}.app`, `com.${n.toLowerCase()}`] as [string, string]));
  const apps = recommend(groupProcesses(procs, CLASSIFY), {
    health, bundleIds: ids,
    protectionOf: g => protectionFor(g, { hostPids: new Set(), isProtected: n => n === 'Mail' }),
    activityKey: a => a.bundleId, activity: (k, p) => act.activityOf(k, p, NOW), growth: () => null, isMuted: n => muted.includes(n),
  });
  return Object.fromEntries(apps.map(a => [a.name, a])) as Record<string, AppSummary>;
}
test('recommend: app idle 45 min is recommended under pressure, with reasons', () => {
  const r = scenario('High');
  assert.equal(r.Chat.recommended, true);
  assert.equal(r.Chat.status, 'Review');
  assert.equal(r.Chat.reasons[0], 'Not used for 45 min');
});
test('recommend: large but recently used / front / busy / tiny apps are never recommended', () => {
  const r = scenario('High');
  assert.equal(r.Code.recommended, false); assert.equal(r.Code.reasons[0], 'Used 3 min ago');
  assert.equal(r.Browser.recommended, false); assert.equal(r.Browser.activeNow, true);
  assert.equal(r.Sync.recommended, false); assert.ok(r.Sync.reasons.includes('Not in front, but working in the background'));
  assert.equal(r.Tiny.recommended, false);
  assert.equal(r.Sync.idleAtLeast, true);
});
test('recommend: protected apps are excluded', () => {
  const r = scenario('High');
  assert.equal(r.Mail.status, 'Protected');
  assert.equal(r.Mail.recommended, false);
});
test('recommend: normal pressure → optional suggestion only', () => {
  const r = scenario('Healthy');
  assert.equal(r.Chat.recommended, false);
  assert.equal(r.Chat.suggested, true);
  assert.equal(r.Chat.status, 'Normal');
});
test('recommend: learned "kept open" apps are muted', () => {
  const r = scenario('High', ['Chat']);
  assert.equal(r.Chat.recommended, false);
  assert.equal(r.Chat.reasons[0], 'Idle, but you usually keep it open');
});
test('activity: user away does not count as use; first minutes are unknown', () => {
  const a = new ActivityTracker(null, NOW);
  a.setState({ coverageStart: NOW - 2 * MIN }, { key: 'com.x', pid: 1, present: false });
  assert.equal(a.activityOf('com.x', [1], NOW).activeNow, false);
  assert.equal(a.activityOf('com.never', [999], NOW).idleMinutes, null);
});

/* ── Process classification & System Critical blocking ── */
test('classification: system paths, self, apple user apps, helpers', () => {
  const g = groupProcesses([
    { pid: 50, ppid: 1, name: 'WindowServer', command: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer', cpu: 0, memory: MB, user: '_windowserver' },
    { pid: 51, ppid: 1, name: 'Calculator', command: '/System/Applications/Calculator.app/Contents/MacOS/Calculator', cpu: 0, memory: MB, user: 'me' },
    { pid: 52, ppid: 1, name: 'node', command: 'node /nex-root/apps/memnex-api/dist/main.js', cpu: 0, memory: MB, user: 'me' },
    { pid: 53, ppid: 1, name: 'Google Chrome Helper (Renderer)', command: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer', cpu: 0, memory: MB, user: 'me' },
    { pid: 54, ppid: 1, name: 'Google Chrome', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', cpu: 0, memory: MB, user: 'me' },
  ], CLASSIFY);
  const by = Object.fromEntries(g.map(x => [x.name, x]));
  assert.equal(by['macOS system services'].kind, 'system');
  assert.equal(by.Calculator.kind, 'app');
  assert.equal(by['NEX Workbench'].kind, 'self');
  assert.deepEqual(by['Google Chrome'].pids.sort(), [53, 54]);
  assert.equal(by['Google Chrome'].mainPid, 54);
});
test('protection: system, self, host app and user protection are enforced', () => {
  const groups = groupProcesses([proc(10, 'Terminal', 100), proc(11, 'Notes', 100)], CLASSIFY);
  const host = protectionFor(groups.find(g => g.name === 'Terminal')!, { hostPids: new Set([10]), isProtected: () => false });
  assert.equal(host?.status, 'System Critical');
  assert.match(host!.reason, /running inside this app/);
  assert.equal(protectionFor(groups.find(g => g.name === 'Notes')!, { hostPids: new Set(), isProtected: () => true })?.status, 'Protected');
  assert.equal(protectionFor(groups.find(g => g.name === 'Notes')!, { hostPids: new Set(), isProtected: () => false }), null);
});
test('assertControllable blocks System Critical and Protected with a reason', () => {
  const base = { id: 'x', name: 'X', kind: 'app', reasons: ['Part of the operating system.'] } as unknown as AppSummary;
  assert.throws(() => assertControllable({ ...base, status: 'System Critical' }), (e: unknown) => e instanceof MemnexError && e.code === 'forbidden');
  assert.throws(() => assertControllable({ ...base, status: 'Protected' }), (e: unknown) => e instanceof MemnexError && e.code === 'forbidden');
  assert.throws(() => assertControllable(undefined), (e: unknown) => e instanceof MemnexError && e.code === 'not_found');
  assert.equal(assertControllable({ ...base, status: 'Normal' }).name, 'X');
});

/* ── Protected applications / learned preferences (JSON file, no database) ── */
test('preferences: protect, learn kept-open, mute and unmute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memnex-'));
  const p = new PreferenceStore(join(dir, 'settings.json'));
  p.setProtected('VS Code', true);
  assert.equal(p.isProtected('vs code'), true);
  for (let i = 0; i < KEPT_OPEN_LIMIT; i++) p.learn(['Slack'], []);
  assert.equal(p.isMuted('Slack'), true);
  p.learn([], ['Slack']);
  assert.equal(p.isMuted('Slack'), false);
  // persisted and reloaded
  assert.equal(new PreferenceStore(join(dir, 'settings.json')).isProtected('VS Code'), true);
});

/* ── Memory growth ── */
test('growth: steady growth detected and attributed; settled spike ignored', () => {
  const g = new MemoryGrowth();
  g.setSeries('app:x', 1, Array.from({ length: 13 }, (_, i) => ({ t: NOW - (12 - i) * 2 * MIN, bytes: (1000 + i * 70) * MB, byPid: { 11: (300 + i * 65) * MB, 12: (700 + i * 5) * MB } })), { 11: 'Code Helper (Plugin)', 12: 'Code Helper (Renderer)' });
  const r = g.growthOf('app:x');
  assert.equal(r?.minutes, 24);
  assert.equal(Math.round(r!.bytes / MB), 840);
  assert.equal(r?.top?.name, 'Code Helper (Plugin)');
  g.setSeries('app:y', 1, Array.from({ length: 13 }, (_, i) => ({ t: NOW - (12 - i) * 2 * MIN, bytes: (i === 6 ? 2500 : 1000) * MB, byPid: {} })));
  assert.equal(g.growthOf('app:y'), null);
});

/* ── Diagnosis ── */
test('diagnosis: names idle apps / growth as cause; stays quiet when healthy', () => {
  const apps = Object.values(scenario('High'));
  const base = { pressure: 'warn' as const, swapRising: true, swapRate: 35 * MB, compressed: 5 * GB, total: 16 * GB, cpuUsage: 30, cores: 8, processes: [], watchingMinutes: 60 };
  let d = diagnose({ ...base, state: 'High', apps });
  assert.equal(d.tone, 'act');
  assert.match(d.headline, /^Memory is tight and macOS is moving memory to disk\. Chat/);
  assert.ok(d.actions.every(a => a.kind === 'close'));
  const grown = apps.map(a => (a.name === 'Code' ? { ...a, growth: { bytes: 2.4 * GB, minutes: 40, top: { pid: 11, name: 'Code Helper (Plugin)', bytes: 2 * GB } } } : a));
  d = diagnose({ ...base, state: 'High', apps: grown });
  assert.equal(d.actions[0].kind, 'restart');
  const calm = apps.map(a => ({ ...a, recommended: false, suggested: false }));
  d = diagnose({ ...base, pressure: 'normal', swapRising: false, state: 'Healthy', apps: calm });
  assert.equal(d.headline, 'Everything is running smoothly.');
  assert.equal(d.actions.length, 0);
  d = diagnose({ ...base, pressure: 'normal', swapRising: false, state: 'Healthy', apps: calm, processes: [{ pid: 0, name: 'kernel_task', cpu: 240 } as never] });
  assert.match(d.headline, /keep the Mac cool/);
});

/* ── Cleanup preview / result ── */
test('cleanup preview: learning state and "no cleanup necessary"', () => {
  const s = (state: Health, watchingMinutes: number, apps: AppSummary[] = []) => ({ memory: { state }, apps, watchingMinutes } as unknown as Snapshot);
  assert.equal(buildPreview(s('High', 5)).learning, true);
  assert.match(buildPreview(s('Healthy', 60)).note, /No cleanup necessary/);
  const r = scenario('High');
  const p = buildPreview(s('High', 60, Object.values(r)));
  assert.deepEqual(p.candidates.map(a => a.name), ['Chat']);
});
test('cleanup result is measured from the real process list afterwards', () => {
  const r = scenario('High');
  const out = summarizeCleanup([r.Chat, r.Code], [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }], [{ ...proc(200, 'Code', 2000), app: 'Code', protected: false }]);
  assert.deepEqual(out.closed.map(a => a.name), ['Chat']);
  assert.deepEqual(out.stillRunning, ['Code']);
  assert.equal(out.released, 800 * MB);
});
test('reopen registry: only apps MemNEX closed, only for an hour', () => {
  const reg = new ReopenRegistry();
  reg.remember({ id: 'app:/A.app', name: 'A', kind: 'app', bundleId: 'com.a', path: '/A.app' }, NOW);
  reg.remember({ id: 'cli:node', name: 'node', kind: 'cli', bundleId: null, path: null }, NOW);
  assert.equal(reg.take('cli:node', NOW), null);
  assert.equal(reg.take('app:/A.app', NOW + 61 * MIN), null);
  reg.remember({ id: 'app:/A.app', name: 'A', kind: 'app', bundleId: 'com.a', path: '/A.app' }, NOW);
  assert.equal(reg.take('app:/A.app', NOW + MIN)?.name, 'A');
});
