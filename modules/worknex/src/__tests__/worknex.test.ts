import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForegroundWindow, ProcessInfo } from '@nex/shared';
import type { PlatformAdapter } from '@nex/platform-core';
import { appKindOf, associateProject, fileFromTitle, normalizeActivity, titleParts } from '../activity-engine';
import { ContextTracker, documentFamily, keyFor } from '../context-engine';
import { applyRetention, buildInsights, buildTimeline, buildTimesheet, dayOf, isIdle, roundHalfHour, timesheetCsv, whereWasI } from '../session-engine';
import { DEFAULT_SETTINGS, isExcludedPath, normalizeSettings, permissionsFor, sanitizeActivity, trackedAppFor } from '../privacy-engine';
import { buildResumePlan, executeResume, toSaved } from '../resume-engine';
import { WorknexEngine } from '../engine';
import { createWorknexModule } from '../module';
import type { ActivityEvent, KnownProject, TrackedApplication, WorkContext, WorknexSettings } from '../types';

const tmp = mkdtempSync(join(tmpdir(), 'worknex-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const T0 = new Date(2026, 10, 10, 9, 0, 0).getTime(); // 09:00 local
const at = (min: number) => new Date(T0 + min * MIN);

const PROJECTS: KnownProject[] = [
  { id: 'sf', name: 'SmartFlowNEX', path: '/Users/me/code/SmartFlowNEX', services: [{ name: 'frontend', port: 3000, running: true }, { name: 'backend', port: 4000, running: true }] },
  { id: 'nex', name: 'NEX Workbench', path: '/Users/me/Documents/NEXWorkbench', services: [{ name: 'workbench-web', port: 3900, running: true }] },
];

const fw = (o: Partial<ForegroundWindow>): ForegroundWindow =>
  ({ appName: 'Code', key: 'com.microsoft.VSCode', bundleId: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app', pid: 100, title: null, titleStatus: 'ok', idleMs: 1000, ...o });
const CODE = { appName: 'Code', key: 'com.microsoft.VSCode', bundleId: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app' };
const TERM = { appName: 'Terminal', key: 'com.apple.Terminal', bundleId: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app' };
const CHROME = { appName: 'Google Chrome', key: 'com.google.Chrome', bundleId: 'com.google.Chrome', path: '/Applications/Google Chrome.app' };
const PPT = { appName: 'Microsoft PowerPoint', key: 'com.microsoft.Powerpoint', bundleId: 'com.microsoft.Powerpoint', path: '/Applications/Microsoft PowerPoint.app' };
const EXCEL = { appName: 'Microsoft Excel', key: 'com.microsoft.Excel', bundleId: 'com.microsoft.Excel', path: '/Applications/Microsoft Excel.app' };
const ZOOM = { appName: 'zoom.us', key: 'us.zoom.xos', bundleId: 'us.zoom.xos', path: '/Applications/zoom.us.app' };

const ev = (w: ForegroundWindow, minute: number, extra: { dirs?: string[]; url?: string | null } = {}): ActivityEvent =>
  normalizeActivity(w, { at: at(minute), projects: PROJECTS, dirs: extra.dirs, url: extra.url, trackFiles: true });

/** Feed one observation per `step` minutes from `from` to `to` (exclusive). */
function feed(tr: ContextTracker, w: ForegroundWindow, from: number, to: number, step = 5 / 60) {
  for (let m = from; m < to - 1e-9; m += step) tr.observe(ev(w, m), at(m));
}

/* ── Activity normalization ── */
test('activity: app kinds from names and bundle ids', () => {
  assert.equal(appKindOf(CODE), 'editor');
  assert.equal(appKindOf(TERM), 'terminal');
  assert.equal(appKindOf(CHROME), 'browser');
  assert.equal(appKindOf(PPT), 'document');
  assert.equal(appKindOf(ZOOM), 'meeting');
  assert.equal(appKindOf({ appName: 'Spotify', bundleId: 'com.spotify.client', path: null }), 'other');
});
test('activity: window titles → parts and file names', () => {
  assert.deepEqual(titleParts('● version.service.ts — SmartFlowNEX'), ['version.service.ts', 'SmartFlowNEX']);
  assert.deepEqual(titleParts('Pull request #12 - GitHub - Google Chrome'), ['Pull request #12', 'GitHub']);
  assert.equal(fileFromTitle('version.service.ts — SmartFlowNEX', 'editor'), 'version.service.ts');
  assert.equal(fileFromTitle('ISO29110_Executive_v6.pptx', 'document'), 'ISO29110_Executive_v6.pptx');
  assert.equal(fileFromTitle('ISO29110_Cost - Excel', 'document'), 'ISO29110_Cost');
  assert.equal(fileFromTitle('nexworkbench — -zsh — 80×24', 'terminal'), null);
  assert.equal(fileFromTitle('example.com', 'browser'), null);
});
test('activity: normalized event carries metadata only', () => {
  const e = ev(fw({ ...CODE, title: 'version.service.ts — SmartFlowNEX' }), 0);
  assert.equal(e.app, 'Code');
  assert.equal(e.appKind, 'editor');
  assert.equal(e.fileName, 'version.service.ts');
  assert.equal(e.projectId, 'sf');
  assert.ok(e.signals.includes('window-title'));
  assert.equal(e.source, 'foreground');
});

/* ── DevNEX context association ── */
test('association: title segment, child working directory, localhost port; ambiguous → none', () => {
  assert.equal(associateProject(PROJECTS, { title: 'engine.ts — NEXWorkbench' })?.project.id, 'nex');
  assert.equal(associateProject(PROJECTS, { title: 'NEX Workbench' })?.project.id, 'nex');
  assert.equal(associateProject(PROJECTS, { dirs: ['/Users/me/code/SmartFlowNEX/apps/web'] })?.signal, 'process-cwd');
  assert.equal(associateProject(PROJECTS, { url: 'http://localhost:3000/login' })?.project.id, 'sf');
  assert.equal(associateProject(PROJECTS, { dirs: ['/Users/me/code/SmartFlowNEX', '/Users/me/Documents/NEXWorkbench'] }), null, 'two windows, no title → do not guess');
  assert.equal(associateProject(PROJECTS, { title: 'NEX Workbench', dirs: ['/Users/me/code/SmartFlowNEX', '/Users/me/Documents/NEXWorkbench'] })?.project.id, 'nex', 'title disambiguates');
  assert.equal(associateProject(PROJECTS, { title: 'my SmartFlowNEX notes' }), null, 'substring is not enough');
  assert.equal(associateProject(PROJECTS, { url: 'http://localhost:5555/' }), null);
});

/* ── Context grouping ── */
test('grouping: editor + terminal + localhost browser of one project → one development context', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'version.service.ts — SmartFlowNEX' }), 0, 10);
  feed(tr, fw({ ...TERM, title: 'SmartFlowNEX — -zsh — 80×24' }), 10, 14);
  for (let m = 14; m < 18; m += 5 / 60) tr.observe(ev(fw({ ...CHROME, title: 'Login - Google Chrome' }), m, { url: 'http://localhost:3000/login' }), at(m));
  const dev = tr.contexts.filter(c => c.type === 'development');
  assert.equal(dev.length, 1);
  assert.equal(dev[0].title, 'SmartFlowNEX');
  assert.deepEqual(dev[0].applications.map(a => a.name).sort(), ['Code', 'Google Chrome', 'Terminal']);
  assert.equal(dev[0].files[0].name, 'version.service.ts');
});
test('grouping: documents of one family group; unrelated documents stay separate', () => {
  assert.deepEqual(documentFamily('ISO29110_Executive_v6.pptx'), { key: 'iso29110', label: 'ISO29110' });
  assert.equal(documentFamily('Untitled.docx'), null);
  assert.equal(documentFamily('2026_Report.xlsx'), null);
  assert.equal(documentFamily('SRS_v1.4.docx'), null, 'short tokens are too generic to group by');
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...PPT, title: 'ISO29110_Executive_v6.pptx' }), 0, 10);
  feed(tr, fw({ ...EXCEL, title: 'ISO29110_Cost.xlsx' }), 10, 20);
  feed(tr, fw({ ...EXCEL, title: 'Budget_2027.xlsx' }), 20, 30);
  const docs = tr.contexts.filter(c => c.type === 'document');
  assert.deepEqual(docs.map(c => c.title), ['ISO29110', 'Budget']);
  assert.equal(docs[0].applications.length, 2);
});
test('separation: different projects never merge; the same project much later starts a new context', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 0, 10);
  feed(tr, fw({ ...CODE, title: 'b.ts — NEXWorkbench' }), 10, 20);
  feed(tr, fw({ ...CODE, title: 'c.ts — SmartFlowNEX' }), 20, 30);
  assert.equal(tr.contexts.length, 2, 'returning to SmartFlowNEX within the window continues it');
  feed(tr, fw({ ...CODE, title: 'd.ts — SmartFlowNEX' }), 30 + 5 * 60, 30 + 5 * 60 + 5);
  assert.equal(tr.contexts.filter(c => c.key === 'project:sf').length, 2, 'after the reuse window a new context starts');
});
test('meetings are their own context and recorded as the interruption', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 0, 10);
  feed(tr, fw({ ...ZOOM, title: 'Zoom Meeting' }), 10, 40);
  const sf = tr.contexts.find(c => c.key === 'project:sf')!;
  const meeting = tr.contexts.find(c => c.type === 'meeting')!;
  assert.equal(meeting.title, 'Zoom meeting');
  assert.equal(sf.interruptions[0].by, 'zoom.us');
  assert.equal(sf.isActive, false);
});

/* ── Sessions, idle, timeline ── */
test('session merging: a short interruption does not split the context in the timeline', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 0, 30);
  feed(tr, fw({ appName: 'Slack', key: 'com.tinyspeck.slackmacgap', bundleId: 'com.tinyspeck.slackmacgap', path: '/Applications/Slack.app', title: null }), 30, 31.5);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 31.5, 60);
  const tl = buildTimeline(tr.contexts, dayOf(at(0)));
  assert.equal(tl.length, 1);
  assert.equal(tl[0].title, 'SmartFlowNEX');
  assert.deepEqual(tl[0].brief, ['Slack']);
});
test('timeline: long switches are separate entries in time order', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 0, 30);
  feed(tr, fw({ ...ZOOM, title: 'Zoom Meeting' }), 30, 60);
  feed(tr, fw({ ...PPT, title: 'ISO29110_Executive_v6.pptx' }), 60, 90);
  assert.deepEqual(buildTimeline(tr.contexts, dayOf(at(0))).map(e => e.title), ['SmartFlowNEX', 'Zoom meeting', 'ISO29110']);
  assert.deepEqual(buildTimeline(tr.contexts, dayOf(at(24 * 60))), [], 'another day is empty');
});
test('idle detection ends the span and explains why', () => {
  assert.equal(isIdle(11 * MIN, 10), true);
  assert.equal(isIdle(2 * MIN, 10), false);
  assert.equal(isIdle(null, 10), false);
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 0, 20);
  tr.pause('idle', at(31));
  const c = tr.contexts[0];
  assert.equal(c.isActive, false);
  assert.equal(c.interruptions[0].kind, 'idle');
  assert.equal(whereWasI(tr.contexts)?.changedWhen, 'You stepped away from the computer.');
});
test('where was I: most recent meaningful context, with the clear reason it stopped', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'version.service.ts — SmartFlowNEX' }), 0, 20);
  feed(tr, fw({ ...ZOOM, title: 'Zoom Meeting' }), 20, 50);
  const w = whereWasI(tr.contexts)!;
  assert.equal(w.context.title, 'SmartFlowNEX', 'a meeting is not "work to resume"');
  assert.equal(w.recentFile, 'version.service.ts');
  assert.equal(w.changedWhen, 'Context changed when zoom.us became active.');
});
test('insights: descriptive only (no score) and detects back-and-forth', () => {
  const tr = new ContextTracker([], 5000);
  // Afternoon: alternate between two contexts.
  for (let i = 0; i < 6; i++) {
    feed(tr, fw({ ...CODE, title: 'a.ts — NEXWorkbench' }), 300 + i * 20, 310 + i * 20);
    feed(tr, fw({ ...PPT, title: 'ISO29110_Executive_v6.pptx' }), 310 + i * 20, 320 + i * 20);
  }
  const ins = buildInsights(tr.contexts, dayOf(at(300)));
  assert.equal(ins.majorContexts, 2);
  assert.ok(ins.observations.some(o => /switched \d+ times between/.test(o)));
  assert.ok(!('score' in ins) && !Object.keys(ins).some(k => /score|efficien|productiv/i.test(k)));
});

/* ── Retention ── */
test('retention: old contexts and finished glances are removed; saved ones are kept', () => {
  const mk = (id: string, lastMin: number, durMs: number, saved = false): WorkContext => ({
    id, key: id, title: id, type: 'development', startedAt: at(lastMin).toISOString(), lastActiveAt: at(lastMin).toISOString(),
    spans: [{ start: at(lastMin).toISOString(), end: new Date(T0 + lastMin * MIN + durMs).toISOString() }], applications: [], files: [], urls: [],
    confidence: 1, isActive: false, isSaved: saved, sourceSignals: [], interruptions: [],
  });
  const now = T0 + 40 * 24 * 60 * MIN;
  const kept = applyRetention([mk('old', 0, 10 * MIN), mk('oldSaved', 0, 10 * MIN, true), mk('recent', 39 * 24 * 60, 10 * MIN), mk('glance', 39 * 24 * 60, 10_000)], 30, now);
  assert.deepEqual(kept.map(c => c.id), ['oldSaved', 'recent']);
});

/* ── Privacy engine: allowlist (no consent, no tracking) ── */
const tracked = (w: Partial<ForegroundWindow>, level: 1 | 2 | 3 = 1, url = false, kind: TrackedApplication['kind'] = 'editor'): TrackedApplication => ({
  id: `t-${w.bundleId}`, applicationId: w.bundleId!, displayName: w.appName!, bundleId: w.bundleId!, kind, enabled: true, level,
  permissions: permissionsFor(level, kind, url), addedAt: at(0).toISOString(),
});
const withApps = (...apps: TrackedApplication[]): WorknexSettings => ({ ...DEFAULT_SETTINGS, trackedApplications: apps });

test('privacy defaults: nothing is tracked on a fresh install; URLs, titles and files are off for new apps', () => {
  assert.deepEqual(DEFAULT_SETTINGS.trackedApplications, []);
  assert.equal(DEFAULT_SETTINGS.trackUrlsByDefault, false);
  assert.equal(DEFAULT_SETTINGS.trackWindowTitlesByDefault, false);
  assert.equal(DEFAULT_SETTINGS.trackFileMetadataByDefault, false);
  assert.equal(sanitizeActivity(fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), DEFAULT_SETTINGS, 600_000), null);
});
test('privacy: settings normalize untrusted input and drop legacy blocklist keys', () => {
  const s = normalizeSettings({ trackUrlsByDefault: 'yes', retentionDays: 9999, excludedApps: ['LINE'], trackApplications: true, trackedApplications: [{ applicationId: 'x' }, 42] });
  assert.equal(s.trackUrlsByDefault, false);
  assert.equal(s.retentionDays, 30);
  assert.deepEqual(s.trackedApplications, [], 'malformed entries are not consent');
  assert.ok(!('excludedApps' in s) && !('trackApplications' in s));
});
test('privacy: allowlist matches stable identity (bundle id / executable), never the display name', () => {
  const s = withApps(tracked(CODE));
  assert.ok(trackedAppFor(CODE, s));
  assert.equal(trackedAppFor({ bundleId: 'com.evil.Code', path: '/tmp/Code.app', key: 'com.evil.Code' }, s), null, 'a different app (even if named Code) does not match');
  const win: TrackedApplication = { ...tracked({ appName: 'Code', bundleId: undefined as never }), applicationId: 'c:\\apps\\code.exe', bundleId: undefined, executable: 'C:\\Apps\\Code.exe' };
  assert.ok(trackedAppFor({ bundleId: null, path: 'C:\\Apps\\Code.exe', key: 'c:\\apps\\code.exe' }, withApps(win)));
});
test('privacy: unapproved app → null (dropped before anything else sees it)', () => {
  const s = withApps(tracked(CODE, 3));
  assert.equal(sanitizeActivity(fw({ appName: 'LINE', key: 'jp.naver.line.mac', bundleId: 'jp.naver.line.mac', title: 'Chat with Mom' }), s, 600_000), null);
  assert.equal(sanitizeActivity(fw({ appName: 'LINE', key: 'jp.naver.line.mac', bundleId: 'jp.naver.line.mac', idleMs: 99 * MIN }), s, 600_000), null, 'even idleness of an untracked app is not reported');
  assert.equal(sanitizeActivity(fw({ ...CODE }), { ...s, paused: true }, 600_000), null);
  assert.equal(sanitizeActivity(fw({ ...CODE }), withApps({ ...tracked(CODE), enabled: false }), 600_000), null);
});
test('privacy: permission levels strip what was not granted', () => {
  const presence = sanitizeActivity(fw({ ...CODE, title: 'secret.ts — X' }), withApps(tracked(CODE, 1)), 600_000);
  assert.ok(presence?.kind === 'app' && presence.fw.title === null, 'presence only → no window title');
  const context = sanitizeActivity(fw({ ...CODE, title: 'secret.ts — X' }), withApps(tracked(CODE, 2)), 600_000);
  assert.ok(context?.kind === 'app' && context.fw.title === 'secret.ts — X');
  assert.deepEqual(permissionsFor(2, 'editor'), { presence: true, windowTitle: true, fileMetadata: false, browserTitle: false, url: false });
  const chrome2 = sanitizeActivity(fw({ ...CHROME, title: 'Bank - Google Chrome' }), withApps(tracked(CHROME, 2, false, 'browser')), 600_000);
  assert.ok(chrome2?.kind === 'app' && chrome2.fw.title === null, 'tab titles need the extended level');
  assert.equal(permissionsFor(3, 'browser').url, false, 'URL is never implied by a level');
  assert.equal(permissionsFor(1, 'browser', true).url, false, 'presence can never carry URLs');
});
test('privacy: excluded folders still apply inside tracked apps', () => {
  assert.ok(isExcludedPath('/Users/me/Private/tax.pdf', ['/Users/me/Private']));
  assert.ok(!isExcludedPath('/Users/me/PrivateWork/a.md', ['/Users/me/Private']));
});

/* ── Engine (fake platform): mandatory privacy acceptance tests ── */
type Fake = { front: ForegroundWindow; url: string | null; opened: string[]; urlCalls: number; foregroundCalls: number; titleCalls: number; procs: ProcessInfo[]; callCpu: number };
function fakePlatform(f: Fake): PlatformAdapter {
  const p: Partial<PlatformAdapter> = {
    id: 'darwin',
    foregroundWindow: async ({ title }) => { f.foregroundCalls++; if (title) f.titleCalls++; return { ...f.front, title: title ? f.front.title : null, titleStatus: title ? 'ok' : 'off' }; },
    browserUrl: async () => { f.urlCalls++; return f.url; },
    openDocuments: async () => [],
    installedApplications: async () => [],
    bundleId: async () => null,
    listProcesses: async () => f.procs,
    appCpuPercent: async () => f.callCpu,
    processCwds: async () => new Map(),
    openPath: async (x: string) => { f.opened.push(`path:${x}`); },
    openUrl: async (x: string) => { f.opened.push(`url:${x}`); },
    openWith: async (_a, x: string) => { f.opened.push(`with:${x}`); },
    openTerminal: async (x: string) => { f.opened.push(`term:${x}`); },
    launch: async t => { f.opened.push(`launch:${t.bundleId ?? t.path}`); },
  };
  return p as PlatformAdapter;
}
const LINE = fw({ appName: 'LINE', key: 'jp.naver.line.mac', bundleId: 'jp.naver.line.mac', path: '/Applications/LINE.app', title: 'SmartFlowNEX — chat with Mom' });
function makeEngine(name: string, projects = PROJECTS) {
  const f: Fake = { front: fw({ ...CODE, title: 'version.service.ts — SmartFlowNEX' }), url: null, opened: [], urlCalls: 0, foregroundCalls: 0, titleCalls: 0, procs: [], callCpu: 0 };
  const events: { type: string; data: unknown }[] = [];
  let clock = T0;
  const dir = join(tmp, name);
  const engine = new WorknexEngine({
    platform: fakePlatform(f), dataDir: dir, sampleMs: 5000, now: () => clock,
    directory: { projects: async () => projects, gitBranch: async () => 'feature/versioning' },
    emit: (type, data) => events.push({ type, data }),
  });
  const run = async (minutes: number) => { for (let m = 0; m < minutes * 12; m++) { await engine.tick(new Date(clock)); clock += 5000; } };
  const track = (w: Pick<ForegroundWindow, 'appName' | 'bundleId' | 'path'>, level: 1 | 2 | 3 = 2, url = false) => {
    const a = engine.addTrackedApp({ applicationId: w.bundleId!, displayName: w.appName!, bundleId: w.bundleId!, executable: w.path! });
    return level === 1 && !url ? a : engine.updateTrackedApp(a.id, { level, url });
  };
  const disk = () => ['history.json', 'saved.json', 'settings.json'].map(x => (existsSync(join(dir, x)) ? readFileSync(join(dir, x), 'utf8') : '')).join('\n');
  return { engine, f, events, run, dir, track, disk, setClock: (ms: number) => { clock = ms; } };
}

test('acceptance · default: a fresh install collects nothing — not even an OS read', async () => {
  const { engine, f, run, disk } = makeEngine('fresh');
  assert.equal(engine.status().trackedApps, 0);
  await run(5);
  engine.flush(true);
  assert.equal(f.foregroundCalls, 0);
  assert.equal(engine.recent().length, 0);
  assert.equal(engine.rawCount(), 0);
  assert.ok(!/Code|VSCode|SmartFlowNEX/.test(disk()));
});
test('acceptance · unapproved app: discarded, never persisted, never in timeline, never grouped', async () => {
  const { engine, f, run, track, disk } = makeEngine('unapproved');
  track(CODE, 2);
  await run(10);                      // VS Code (tracked)
  f.front = LINE; await run(15);      // LINE (not tracked) — title even names the project
  f.front = fw({ ...CODE, title: 'version.service.ts — SmartFlowNEX' }); await run(10);
  engine.flush(true);
  const everything = JSON.stringify(engine.recent()) + JSON.stringify(engine.timeline(dayOf(at(0)))) + JSON.stringify(engine.insights(dayOf(at(0)))) + JSON.stringify(await engine.where()) + disk();
  assert.ok(!/LINE|naver|Mom/i.test(everything), 'no trace of the untracked app anywhere');
  const ctx = engine.recent();
  assert.equal(ctx.length, 1);
  assert.deepEqual(ctx[0].applications.map(a => a.name), ['Code'], 'LINE did not contribute to grouping');
  assert.deepEqual(ctx[0].interruptions, [], 'the gap is not explained by naming the other app');
  const tl = engine.timeline(dayOf(at(0))).entries;
  assert.equal(tl.length, 2, 'a gap where the untracked app was used');
  assert.ok(engine.rawCount() > 0 && !JSON.stringify(engine.recent()).includes('LINE'));
});
test('acceptance · no logging / event leakage of unapproved apps', async () => {
  const { f, run, track, events } = makeEngine('logs');
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) (console as any)[k] = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    track(CODE, 3);
    await run(3);
    f.front = LINE; await run(5);
  } finally { Object.assign(console, orig); }
  const all = lines.join('\n') + JSON.stringify(events);
  assert.ok(!/LINE|naver|Mom/i.test(all));
});
test('acceptance · permission level: presence only → window title never requested or stored', async () => {
  const { engine, f, run, track, disk } = makeEngine('presence');
  track(CODE, 1);
  await run(6);
  engine.flush(true);
  assert.equal(f.titleCalls, 0, 'the OS is not even asked for the title');
  const c = engine.recent()[0];
  assert.equal(c.title, 'Code');
  assert.equal(c.lastTitle, undefined);
  assert.deepEqual(c.files, []);
  assert.ok(!/version\.service|SmartFlowNEX/.test(disk()));
});
test('acceptance · URL permission: URLs are discarded unless explicitly allowed for that browser', async () => {
  const { engine, f, run, track, disk } = makeEngine('urls');
  const chrome = track(fw(CHROME), 3);
  f.front = fw({ ...CHROME, title: 'Login - Google Chrome' });
  f.url = 'https://bank.example.com/account?id=123';
  await run(4);
  engine.flush(true);
  assert.equal(f.urlCalls, 0, 'the browser is not even asked for its URL');
  assert.ok(!disk().includes('bank.example.com'));
  engine.updateTrackedApp(chrome.id, { url: true });
  await run(1);
  assert.ok(f.urlCalls > 0);
  assert.equal(engine.recent()[0].urls[0].url, 'https://bank.example.com/account?id=123');
});
test('acceptance · removal: stops tracking immediately; history kept or deleted only by explicit choice', async () => {
  const keep = makeEngine('remove-keep');
  const a = keep.track(CODE, 2);
  await keep.run(6);
  keep.engine.removeTrackedApp(a.id, false);
  const before = keep.f.foregroundCalls;
  await keep.run(6);
  assert.equal(keep.f.foregroundCalls, before, 'no further OS reads once nothing is tracked');
  assert.equal(keep.engine.recent().length, 1, 'existing history kept');
  assert.equal(keep.engine.recent()[0].isActive, false);

  const del = makeEngine('remove-delete');
  const b = del.track(CODE, 3);
  const other = del.track(fw(TERM), 2);
  await del.run(6);
  del.f.front = fw({ ...TERM, title: 'SmartFlowNEX — -zsh' }); await del.run(6);
  await del.engine.save('current', { label: 'checkpoint' });
  const res = del.engine.removeTrackedApp(b.id, true);
  del.engine.flush(true);
  const out = JSON.stringify(del.engine.recent()) + JSON.stringify(del.engine.saved()) + del.disk();
  assert.ok(!/com\.microsoft\.VSCode|version\.service/.test(out), 'the app and what it contributed are gone');
  assert.ok(del.engine.recent().every(c => c.applications.every(x => x.name !== 'Code')));
  assert.ok(res.ok);
  assert.ok(del.engine.trackedApps().some(x => x.id === other.id), 'other apps untouched');
});
test('acceptance · pause: no collection from any allowlisted app until resumed', async () => {
  const { engine, f, run, track, events } = makeEngine('paused');
  track(CODE, 2);
  engine.pause();
  await run(5);
  assert.equal(f.foregroundCalls, 0);
  assert.equal(engine.recent().length, 0);
  assert.equal(engine.status().paused, true);
  assert.ok(events.some(e => e.type === 'worknex.collection.paused'));
  engine.resumeTracking();
  await run(5);
  assert.equal(engine.recent()[0].title, 'SmartFlowNEX');
});
test('consent only via tracked-app actions: general settings cannot add apps; Resume never grants tracking', async () => {
  const { engine, f, run, track } = makeEngine('consent');
  engine.updateSettings({ trackedApplications: [{ applicationId: 'jp.naver.line.mac', displayName: 'LINE' }] });
  assert.equal(engine.trackedApps().length, 0);
  const chrome = track(fw(CHROME), 2);
  f.front = fw(CHROME); await run(6);
  const ctx = engine.recent()[0];
  engine.removeTrackedApp(chrome.id, false);
  const plan = await engine.resumePreview('context', ctx.id);
  const launch = plan.items.find(i => i.kind === 'app');
  if (launch) await engine.resume('context', ctx.id, [launch.id]);
  assert.equal(engine.trackedApps().length, 0, 'launching an app is not consent to track it');
});
test('engine: excluded folders do not leak from tracked apps', async () => {
  const secret: KnownProject = { id: 'sec', name: 'ClientSecret', path: '/Users/me/Clients/ClientSecret', services: [] };
  const { engine, f, run, track, disk } = makeEngine('paths', [...PROJECTS, secret]);
  track(CODE, 3);
  engine.updateSettings({ excludedPaths: ['/Users/me/Clients'] });
  f.front = fw({ ...CODE, title: 'contract.md — ClientSecret' });
  await run(5);
  engine.flush(true);
  assert.ok(!/ClientSecret|contract\.md|\/Users\/me\/Clients"/.test(JSON.stringify(engine.recent()) + disk().replace(/"excludedPaths":\s*\[[^\]]*\]/, '')));
});
test('engine: save context → saved list; resume preview → only selected items open', async () => {
  const proj = join(tmp, 'SmartFlowNEX');
  mkdirSync(proj, { recursive: true });
  const local: KnownProject[] = [{ ...PROJECTS[0], path: proj }];
  const { engine, f, run, track } = makeEngine('save', local);
  track(CODE, 2);
  f.front = fw({ ...CODE, title: 'version.service.ts — SmartFlowNEX' });
  await run(6);
  const saved = await engine.save('current', { label: 'SmartFlowNEX — Versioning', note: 'finish rollback' });
  assert.equal(engine.saved()[0].label, 'SmartFlowNEX — Versioning');
  assert.deepEqual(saved.services.map(s => s.port), [3000, 4000]);
  assert.equal(saved.gitBranch, 'feature/versioning');
  assert.equal(engine.recent()[0].isSaved, true);

  const preview = await engine.resumePreview('saved', saved.id);
  const kinds = preview.items.map(i => i.kind);
  assert.ok(kinds.includes('open-with') && kinds.includes('folder') && kinds.includes('service-url') && kinds.includes('devnex'));
  assert.equal(preview.items.find(i => i.kind === 'terminal')!.selected, false, 'terminal is off by default');
  const chosen = preview.items.filter(i => i.kind === 'service-url' && i.detail === 'localhost:3000').map(i => i.id);
  const res = await engine.resume('saved', saved.id, [...chosen, preview.items.find(i => i.kind === 'devnex')!.id]);
  assert.deepEqual(f.opened, ['url:http://localhost:3000'], 'nothing unselected is opened');
  assert.deepEqual(res.routes, ['/devnex/projects/sf']);
  await assert.rejects(engine.resume('saved', saved.id, ['folder:forged']), /out of date/);
  assert.ok(engine.saved()[0].lastResumedAt);
});
test('resume plan: missing files and stopped services are shown but unavailable', () => {
  const c: WorkContext = {
    id: 'c', key: 'project:sf', title: 'SmartFlowNEX', type: 'development', startedAt: at(0).toISOString(), lastActiveAt: at(0).toISOString(),
    spans: [], applications: [], files: [{ name: 'gone.ts', path: '/nope/gone.ts', lastSeenAt: at(0).toISOString() }], urls: [],
    projectId: 'sf', projectPath: '/nope', confidence: 1, isActive: false, isSaved: false, sourceSignals: [], interruptions: [],
  };
  const project = { ...PROJECTS[0], services: [{ name: 'frontend', port: 3000, running: false }] };
  const { plan } = buildResumePlan({ ...c, kind: 'context' }, { project, settings: DEFAULT_SETTINGS, exists: () => false });
  assert.ok(plan.items.every(i => !i.unavailable || !i.selected));
  assert.match(plan.items.find(i => i.kind === 'service-url')!.unavailable!, /Not running/);
  assert.match(plan.items.find(i => i.kind === 'file')!.unavailable!, /not found/);
});
test('resume execute: failures are reported per item, others still open', async () => {
  const opened: string[] = [];
  const os = {
    openPath: async () => { throw new Error('The folder could not be opened.'); }, openUrl: async (u: string) => { opened.push(u); },
    openWith: async () => {}, openTerminal: async () => {}, revealPath: async () => {}, launch: async () => {},
  };
  const r = await executeResume([
    { id: 'a', kind: 'folder', label: 'Open folder', detail: '', selected: true, target: '/x' },
    { id: 'b', kind: 'service-url', label: 'Open web', detail: '', selected: true, target: 'http://localhost:3000' },
  ], ['a', 'b'], os);
  assert.deepEqual(r.opened, ['Open web']);
  assert.equal(r.failed[0].reason, 'The folder could not be opened.');
});
test('save point: references only, never app state', () => {
  const c: WorkContext = {
    id: 'c', key: 'doc:iso29110', title: 'ISO29110', type: 'document', startedAt: at(0).toISOString(), lastActiveAt: at(0).toISOString(),
    spans: [], applications: [{ name: 'PowerPoint', key: 'k', bundleId: 'k', path: null, seconds: 600, kind: 'document' }],
    files: [{ name: 'ISO29110.pptx', path: null, lastSeenAt: at(0).toISOString() }], urls: [], confidence: 1, isActive: false, isSaved: false, sourceSignals: [], interruptions: [],
  };
  const s = toSaved(c, { id: 's', project: null });
  assert.deepEqual(Object.keys(s.applications[0]).sort(), ['bundleId', 'key', 'kind', 'name', 'path']);
  assert.equal(s.label, 'ISO29110');
});
test('clear history removes WorkNEX history only (save points optional)', async () => {
  const { engine, run, dir, track } = makeEngine('clear');
  track(CODE, 2);
  await run(5);
  await engine.save('current', {});
  engine.clearHistory(false);
  assert.equal(engine.recent().length, 0);
  assert.equal(engine.saved().length, 1, 'save points kept unless asked');
  engine.clearHistory(true);
  assert.equal(engine.saved().length, 0);
  assert.ok(existsSync(dir));
});

/* ── Module summary ── */
test('module: not configured is neutral; status, continue-working and conservative attention', async () => {
  const { engine, run, track } = makeEngine('module');
  const fresh = await createWorknexModule(engine, async () => PROJECTS).getStatus();
  assert.equal(fresh.state, 'not-configured');
  assert.equal(fresh.headline, 'No applications are being tracked.');
  track(CODE, 2);
  await run(6);
  const mod = createWorknexModule(engine, async () => PROJECTS, () => T0 + 6 * MIN);
  const status = await mod.getStatus();
  assert.equal(status.state, 'healthy', 'normal work is never an issue');
  assert.equal(status.metrics.find(m => m.label === 'Active')!.value, 'SmartFlowNEX');
  const cont = await mod.getContinueWorkingItems();
  assert.equal(cont[0].title, 'SmartFlowNEX');
  assert.deepEqual(cont[0].services.map(s => s.port), [3000, 4000]);
  assert.equal(cont[0].branch, 'feature/versioning');
  assert.match(cont[0].route, /^\/worknex\/contexts\/.+\?resume=1$/);
  assert.deepEqual(await mod.getAttentionItems(), [], 'no nagging while working');
  const titles = (await mod.getCommands!()).map(c => c.title);
  for (const t of ['Choose apps WorkNEX may track', 'Open WorkNEX', 'Where was I?', 'Save current context', 'Show today’s timeline', 'Pause WorkNEX', 'Resume SmartFlowNEX']) assert.ok(titles.includes(t), t);
});

test('grouping keys: meeting beats project; project beats document; app is the last resort', () => {
  assert.equal(keyFor(ev(fw({ ...CHROME, title: 'Meet - abc-defg-hij - Google Chrome' }), 0)).type, 'meeting');
  assert.equal(keyFor(ev(fw({ ...CODE, title: 'README.md — SmartFlowNEX' }), 0)).key, 'project:sf');
  assert.equal(keyFor(ev(fw({ ...PPT, title: 'ISO29110_Executive_v6.pptx' }), 0)).key, 'doc:iso29110');
  assert.equal(keyFor(ev(fw({ appName: 'Spotify', key: 'com.spotify.client', bundleId: 'com.spotify.client', path: null, title: null }), 0)).type, 'general');
});

/* ── Timesheet (own summary for Workforce/timesheets) ── */
test('timesheet: hours round to the nearest 0.5', () => {
  assert.equal(roundHalfHour(134), 2);    // 2 h 14 m
  assert.equal(roundHalfHour(135), 2.5);  // 2 h 15 m
  assert.equal(roundHalfHour(150), 2.5);
  assert.equal(roundHalfHour(164), 2.5);
  assert.equal(roundHalfHour(165), 3);
  assert.equal(roundHalfHour(10), 0);
});
test('timesheet: exact minutes per work item per day, same project merged; meetings win overlaps (never double)', () => {
  const tr = new ContextTracker([], 5000);
  feed(tr, fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }), 0, 60);            // 60 min SmartFlowNEX
  feed(tr, fw({ ...PPT, title: 'ISO29110_Executive_v6.pptx' }), 60, 90);      // 30 min ISO29110
  feed(tr, fw({ ...CODE, title: 'b.ts — SmartFlowNEX' }), 90, 130);           // +40 min SmartFlowNEX (same context)
  const [d] = buildTimesheet(tr.contexts, [dayOf(at(0))], T0 + 130 * MIN);
  const sf = d.items.find(i => i.title === 'SmartFlowNEX')!;
  assert.ok(Math.abs(sf.minutes - 100) <= 1, `got ${sf.minutes}`);
  assert.equal(sf.hours, 1.5, '1 h 40 m → 1.5');
  assert.equal(d.items.find(i => i.title === 'ISO29110')!.hours, 0.5);
  assert.ok(Math.abs(d.totalMinutes - 130) <= 2);
  // A meeting overlapping other work: the overlap belongs to the meeting only.
  const meeting: WorkContext = { ...tr.contexts[0], id: 'm', key: 'meeting:zoom', title: 'Zoom meeting', type: 'meeting', spans: [{ start: at(30).toISOString(), end: at(60).toISOString() }], isActive: false };
  const [d2] = buildTimesheet([...tr.contexts, meeting], [dayOf(at(0))], T0 + 130 * MIN);
  assert.ok(Math.abs(d2.totalMinutes - 130) <= 2, 'total unchanged — nothing counted twice');
  assert.ok(Math.abs(d2.items.find(i => i.title === 'Zoom meeting')!.minutes - 30) <= 1);
  assert.ok(Math.abs(d2.items.find(i => i.title === 'SmartFlowNEX')!.minutes - 70) <= 1);
});
test('timesheet CSV: one row per day and item, Excel-friendly', () => {
  const csv = timesheetCsv([{ day: '2026-11-10', items: [{ key: 'k', title: 'ISO29110, "deck"', type: 'document', projectPath: null, minutes: 150, hours: 2.5 }], totalMinutes: 150, totalHours: 2.5, itemsHours: 2.5 }]);
  assert.ok(csv.startsWith('\ufeffDate,Work,Type,Project folder,Minutes,Hours (rounded 0.5)\r\n'));
  assert.ok(csv.includes('2026-11-10,"ISO29110, ""deck""",document,,150,2.5'));
});

/* ── Meetings keep counting while a call runs in the background ── */
const ZOOM_PROC: ProcessInfo = { pid: 500, ppid: 1, name: 'zoom.us', command: '/Applications/zoom.us.app/Contents/MacOS/zoom.us', cpu: 0, memory: 300 * 1024 ** 2, user: 'me' };
test('meeting: continues in the background while the call is active, ends when the call ends', async () => {
  const { engine, f, run, track } = makeEngine('meeting-bg');
  track(fw(ZOOM), 1); track(CODE, 2);
  f.procs = [ZOOM_PROC];
  f.callCpu = 25;                                             // in a call
  f.front = fw({ ...ZOOM, title: 'Zoom Meeting' }); await run(10);
  f.front = fw({ ...CODE, title: 'notes.md — SmartFlowNEX' }); await run(20);   // notes during the call
  let meeting = engine.recent().find(c => c.type === 'meeting')!;
  assert.equal(meeting.isActive, true, 'still in the meeting while another app is in front');
  f.callCpu = 0.5;                                           // call ended, app left open
  await run(5);
  meeting = engine.recent().find(c => c.type === 'meeting')!;
  assert.equal(meeting.isActive, false);
  const [d] = engine.timesheet(dayOf(at(0)));
  const m = d.items.find(i => i.type === 'meeting')!;
  assert.ok(m.minutes >= 29 && m.minutes <= 31, `meeting ≈ 30 min, got ${m.minutes}`);
  const sf = d.items.find(i => i.title === 'SmartFlowNEX')!;
  assert.ok(sf.minutes >= 4 && sf.minutes <= 6, `only the time after the call counts for SmartFlowNEX, got ${sf.minutes}`);
});
test('meeting: an open meeting app without a call does not keep counting; idle while listening does not end a call', async () => {
  const { engine, f, run, track } = makeEngine('meeting-idle');
  track(fw(ZOOM), 1); track(CODE, 2);
  f.procs = [ZOOM_PROC];
  f.callCpu = 30;
  f.front = fw({ ...ZOOM, title: 'Zoom Meeting', idleMs: 1000 }); await run(2);        // join the call
  f.front = fw({ ...ZOOM, title: 'Zoom Meeting', idleMs: 15 * MIN }); await run(20);   // then listen, not touching the keyboard
  assert.equal(engine.recent().find(c => c.type === 'meeting')!.isActive, true);
  f.callCpu = 0;
  f.front = fw({ ...ZOOM, title: 'Zoom', idleMs: 1000 }); await run(1);
  f.front = fw({ ...CODE, title: 'a.ts — SmartFlowNEX' }); await run(5);
  assert.equal(engine.recent().find(c => c.type === 'meeting')!.isActive, false, 'no call → no background meeting');
});
test('timesheet: untracked apps never appear and their time is not counted', async () => {
  const { engine, f, run, track } = makeEngine('ts-untracked');
  track(CODE, 2);
  await run(30);
  f.front = LINE; await run(30);
  const [d] = engine.timesheet(dayOf(at(0)));
  assert.ok(!JSON.stringify(d).match(/LINE|naver/));
  assert.ok(d.totalMinutes >= 29 && d.totalMinutes <= 31, `only the 30 tracked minutes, got ${d.totalMinutes}`);
});
