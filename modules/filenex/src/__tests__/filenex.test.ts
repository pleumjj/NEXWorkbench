import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FilenexEngine } from '../engine';
import { approvedLocationFor, isSensitiveName, validateLocationPath } from '../privacy-engine';
import { parseQuery } from '../search-engine';
import { buildVersionGroups, normalizeStem, versionNumber } from '../version-engine';
import type { ProjectRef, WorkContextRef } from '../types';

// Temp tree inside the git-ignored dist folder (the system temp dir lives under /var, which FileNEX refuses as a location).
const root = mkdtempSync(join(__dirname, 'tmp-'));
after(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();
function file(path: string, content = 'x', ageMs = 0) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  const t = new Date(NOW - ageMs);
  utimesSync(path, t, t);
  return path;
}

function makeEngine(name: string, sources: { contexts?: WorkContextRef[]; projects?: ProjectRef[] } = {}) {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  const opened: string[] = [];
  const engine = new FilenexEngine({
    platform: {
      openPath: async p => { opened.push(`open:${p}`); }, revealPath: async p => { opened.push(`reveal:${p}`); },
      openUrl: async () => {}, openWith: async () => {}, openTerminal: async () => {}, launch: async () => {},
    },
    dataDir: join(home, '.filenex-data'), home, background: false,
    sources: { contexts: async () => sources.contexts ?? [], projects: async () => sources.projects ?? [] },
  });
  engine.start();
  const add = async (rel: string) => { const loc = engine.addLocation(join(home, rel)); await engine.scan(loc.id); return loc; };
  const dbRows = () => { const db = new DatabaseSync(join(home, '.filenex-data', 'index.sqlite')); const rows = db.prepare('SELECT path, name FROM filenex_files').all() as { path: string; name: string }[]; db.close(); return rows; };
  return { engine, home, opened, add, dbRows };
}

/* ═════════════ Mandatory privacy acceptance tests ═════════════ */

test('privacy · fresh install: no folders, zero files indexed', async () => {
  const { engine } = makeEngine('fresh');
  const s = engine.status();
  assert.equal(s.configured, false);
  assert.equal(s.locations.length, 0);
  assert.equal(s.indexedFiles, 0);
  assert.equal((await engine.search('')).total, 0);
});

test('privacy · outside allowlist: files outside approved folders are never indexed (symlinks not followed)', async () => {
  const { engine, home, add, dbRows } = makeEngine('outside');
  file(join(home, 'Projects/ISO29110/ISO29110_Executive_v6.pptx'));
  file(join(home, 'Private/diary.docx'));
  mkdirSync(join(home, 'Projects/ISO29110'), { recursive: true });
  symlinkSync(join(home, 'Private'), join(home, 'Projects/link-to-private'));
  await add('Projects');
  const names = engine.store.all().map(f => f.name);
  assert.deepEqual(names, ['ISO29110_Executive_v6.pptx']);
  assert.ok(!dbRows().some(r => /Private|diary/.test(r.path)), 'nothing from outside reaches the database');
});

test('privacy · no persistence of unapproved metadata; sensitive, hidden and dev folders skipped by default', async () => {
  const { engine, home, add, dbRows } = makeEngine('sensitive');
  file(join(home, 'Work/plan.docx'));
  file(join(home, 'Work/.env'));
  file(join(home, 'Work/credentials.json'));
  file(join(home, 'Work/id_rsa'));
  file(join(home, 'Work/server.pem'));
  file(join(home, 'Work/.hidden-notes.md'));
  file(join(home, 'Work/app/node_modules/lib/index.js'));
  file(join(home, 'Work/app/.git/config'));
  file(join(home, 'Work/debug.log'));
  file(join(home, 'Work/Deck.key'));            // Keynote — NOT treated as a secret
  await add('Work');
  assert.deepEqual(engine.store.all().map(f => f.name).sort(), ['Deck.key', 'plan.docx']);
  assert.equal(dbRows().length, 2);
  assert.ok(isSensitiveName('my_password_list.txt') && isSensitiveName('.env.local') && !isSensitiveName('passport-scan.pdf'));
});

test('privacy · folder removal stops indexing immediately — a running scan writes nothing', async () => {
  const { engine, home } = makeEngine('removal');
  for (let i = 0; i < 600; i++) file(join(home, `Big/f${i}.txt`));
  const loc = engine.addLocation(join(home, 'Big'));
  const running = engine.scan(loc.id);
  engine.removeLocation(loc.id, false);
  await running;
  assert.equal(engine.store.count(), 0);
  assert.equal(engine.status().locations.length, 0);
});

test('privacy · removal keeps or deletes the index only by explicit choice; real files untouched', async () => {
  const keep = makeEngine('remove-keep');
  file(join(keep.home, 'A/one.docx'));
  const a = await keep.add('A');
  keep.engine.removeLocation(a.id, false);
  assert.equal(keep.engine.store.count(), 1, 'kept');
  file(join(keep.home, 'A/two.docx'));
  await keep.engine.scan(a.id);
  assert.equal(keep.engine.store.count(), 1, 'no more scanning after removal');

  const del = makeEngine('remove-delete');
  const p = file(join(del.home, 'B/one.docx'));
  const b = await del.add('B');
  del.engine.removeLocation(b.id, true);
  assert.equal(del.engine.store.count(), 0);
  assert.ok(existsSync(p), 'the real file still exists');
});

test('privacy · WorkNEX file references outside approved folders never cause indexing', async () => {
  const contexts: WorkContextRef[] = [];
  const { engine, home, add, dbRows } = makeEngine('worknex', { contexts });
  file(join(home, 'Approved/ISO29110_Cost.xlsx'));
  const outside = file(join(home, 'Elsewhere/ISO29110_Secret.xlsx'));
  contexts.push({ id: 'c1', title: 'ISO29110', type: 'document', startedAt: new Date(NOW - 3600_000).toISOString(), lastActiveAt: new Date(NOW).toISOString(), isActive: true,
    files: [{ name: 'ISO29110_Cost.xlsx', path: null }, { name: 'ISO29110_Secret.xlsx', path: outside }] });
  await add('Approved');
  const work = await engine.recentWork();
  assert.deepEqual(work[0].files.map(f => f.name), ['ISO29110_Cost.xlsx']);
  assert.ok(!dbRows().some(r => r.name.includes('Secret')));
  assert.ok(!(await engine.search('iso29110')).hits.some(h => h.file.name.includes('Secret')));
});

test('privacy · registering a DevNEX project never grants FileNEX permission', async () => {
  const { engine, home } = makeEngine('devnex', { projects: [{ id: 'p1', name: 'SmartFlowNEX', path: '' }] });
  const proj = join(home, 'code/SmartFlowNEX');
  file(join(proj, 'README.md'));
  (engine as any).opts.sources.projects = async () => [{ id: 'p1', name: 'SmartFlowNEX', path: proj }];
  const cols = await engine.collections();
  assert.equal(engine.status().locations.length, 0);
  assert.equal(engine.store.count(), 0);
  assert.equal(cols.projects[0].indexed, false);
  assert.match((await engine.collection('project:p1')).note ?? '', /does not give FileNEX permission/);
});

test('privacy · clear index deletes FileNEX metadata only — never the actual files; rebuild re-indexes approved folders', async () => {
  const { engine, home, add } = makeEngine('clear');
  const paths = [file(join(home, 'Docs/a.docx')), file(join(home, 'Docs/b.xlsx'))];
  const loc = await add('Docs');
  const col = engine.createCollection('Q4 ISO29110');
  engine.addToCollection(col.id, engine.store.all()[0].id);
  engine.clearIndex(false);
  assert.equal(engine.store.count(), 0);
  assert.ok(paths.every(existsSync), 'files are untouched');
  assert.equal(engine.store.collections().length, 1, 'collections kept unless asked');
  assert.equal(engine.status().locations.length, 1, 'folder permission kept');
  engine.rebuild();
  await engine.scan(loc.id);
  assert.equal(engine.store.count(), 2);
  assert.equal(engine.store.collections()[0].fileIds.length, 1, 'collection items reattach (stable ids)');
});

test('privacy · system folders and whole drives are refused; broad folders need confirmation', () => {
  const exists = () => true;
  assert.throws(() => validateLocationPath('/', '/Users/me', exists), /System folders/);
  assert.throws(() => validateLocationPath('/System/Library', '/Users/me', exists), /System folders/);
  assert.throws(() => validateLocationPath('C:\\', 'C:\\Users\\me', exists));
  assert.equal(validateLocationPath('~/Documents/Projects', '/Users/me', exists), '/Users/me/Documents/Projects');
  const { engine, home } = makeEngine('broad');
  mkdirSync(join(home, 'Documents'), { recursive: true });
  assert.throws(() => engine.addLocation(join(home, 'Documents')), /broad folder/);
  assert.ok(engine.addLocation(join(home, 'Documents'), { confirmBroad: true }));
  assert.ok(!approvedLocationFor(join(home, 'Documents2/x.txt'), engine.settings()), 'prefix is not containment');
});

test('pause: no scanning while paused; search over the existing index still works', async () => {
  const { engine, home, add } = makeEngine('pause');
  file(join(home, 'P/report.docx'));
  const loc = await add('P');
  engine.pause();
  file(join(home, 'P/new.docx'));
  await engine.scan(loc.id);
  assert.equal(engine.store.count(), 1);
  assert.equal((await engine.search('report')).hits.length, 1);
  engine.resume();
  await engine.scan(loc.id);
  assert.equal(engine.store.count(), 2);
});

/* ═════════════ Search, relationships, versions, duplicates ═════════════ */

let corpusN = 0;
async function corpus() {
  const contexts: WorkContextRef[] = [];
  const projects: ProjectRef[] = [];
  const e = makeEngine(`corpus-${++corpusN}`, { contexts, projects });
  const W = join(e.home, 'Work');
  file(join(W, 'ISO29110/ISO29110_Executive_v6.pptx'), 'deck', 4 * DAY);
  file(join(W, 'ISO29110/ISO29110_Cost.xlsx'), 'cost', 4 * DAY + 10 * 60_000);
  file(join(W, 'ISO29110/ISO29110_PreAssessment.docx'), 'pre', 20 * DAY);
  file(join(W, 'ISO29110/notes.md'), 'n', 4 * DAY + 5 * 60_000);
  file(join(W, 'Finance/cost_optimization.xlsx'), 'opt', 2 * DAY);
  file(join(W, 'Finance/budget.pdf'), 'b', 40 * DAY);
  file(join(W, 'Procurement/vendor_list.xlsx'), 'v', 3 * DAY);
  const yesterdayNoon = new Date(new Date(NOW).setHours(0, 0, 0, 0) - 12 * 3600_000).getTime();
  file(join(W, 'Slides/team_presentation.pptx'), 's', NOW - yesterdayNoon);      // yesterday 12:00
  file(join(W, 'code/SmartFlowNEX/src/version.service.ts'), 'ts', 3600_000);
  file(join(W, 'Proposals/proposal.docx'), 'p1', 30 * DAY);
  file(join(W, 'Proposals/proposal_final.docx'), 'p22', 20 * DAY);
  file(join(W, 'Proposals/proposal_final2.docx'), 'p333', 2 * DAY);
  file(join(W, 'Proposals/proposal_v6.docx'), 'p4444', 5 * DAY);
  file(join(W, 'Dup/a/Quarterly Summary.pdf'), 'same-bytes', 9 * DAY);
  file(join(W, 'Dup/b/Q3 summary copy.pdf'), 'same-bytes', 8 * DAY);
  file(join(W, 'Dup/Report.pptx'), 'aaa', 6 * DAY);
  file(join(W, 'Dup/Report Copy.pptx'), 'aaaa-edited', 6 * DAY - 60_000);
  contexts.push({ id: 'c-roots', title: 'ROOTS Procurement', type: 'document', startedAt: new Date(NOW - 3 * DAY).toISOString(), lastActiveAt: new Date(NOW - 3 * DAY + 3600_000).toISOString(), isActive: false, files: [{ name: 'vendor_list.xlsx', path: null }] });
  contexts.push({ id: 'c-iso', title: 'ISO29110 Executive Presentation', type: 'document', startedAt: new Date(NOW - 4 * DAY - 3600_000).toISOString(), lastActiveAt: new Date(NOW - 4 * DAY).toISOString(), isActive: false,
    files: [{ name: 'ISO29110_Executive_v6.pptx', path: null }, { name: 'ISO29110_Cost.xlsx', path: null }] });
  projects.push({ id: 'p-sf', name: 'SmartFlowNEX', path: join(W, 'code/SmartFlowNEX') });
  await e.add('Work');
  await e.engine.hashPass();
  return e;
}

test('query parsing: types and dates are understood; the rest are terms', () => {
  const now = new Date(2026, 10, 11, 15, 0);
  const a = parseQuery('presentation modified yesterday', now);
  assert.equal(a.type, 'presentation');
  assert.equal(a.modifiedFrom, new Date(2026, 10, 10).getTime());
  assert.equal(a.modifiedTo, new Date(2026, 10, 11).getTime());
  assert.deepEqual(a.terms, []);
  const b = parseQuery('excel from ISO29110', now);
  assert.equal(b.type, 'spreadsheet');
  assert.deepEqual(b.terms, ['iso29110']);
  assert.equal(parseQuery('slides last week', now).interpreted.join(), 'type: presentation,modified: last week');
});

test('search: filename ranking, partial names, typos and type filters', async () => {
  const { engine } = await corpus();
  const r = await engine.search('ISO29110 presentation');
  assert.equal(r.hits[0].file.name, 'ISO29110_Executive_v6.pptx', 'type + name');
  assert.ok(r.hits.every(h => h.file.fileType === 'presentation'));
  assert.equal((await engine.search('iso291')).hits.length >= 3, true, 'partial filename');
  assert.equal((await engine.search('executve')).hits[0]?.file.name, 'ISO29110_Executive_v6.pptx', 'one typo tolerated');
  const excel = await engine.search('cost optimization excel');
  assert.equal(excel.hits[0].file.name, 'cost_optimization.xlsx');
  assert.ok(excel.hits.every(h => h.file.fileType === 'spreadsheet'));
  assert.ok(r.hits[0].reasons.some(x => /Filename/.test(x)), 'explainable');
});

test('search: modified-date filters', async () => {
  const { engine } = await corpus();
  const y = await engine.search('presentation yesterday');
  assert.deepEqual(y.hits.map(h => h.file.name), ['team_presentation.pptx']);
  const today = await engine.search('today');
  assert.ok(today.hits.every(h => Date.parse(h.file.modifiedAt) >= new Date(new Date().setHours(0, 0, 0, 0)).getTime()));
});

test('search: DevNEX project and WorkNEX context association', async () => {
  const { engine } = await corpus();
  const p = await engine.search('files from SmartFlowNEX');
  assert.equal(p.hits[0].file.name, 'version.service.ts');
  assert.equal(p.hits[0].project?.name, 'SmartFlowNEX');
  const c = await engine.search('ROOTS project procurement');
  assert.equal(c.hits[0].file.name, 'vendor_list.xlsx');
  assert.ok(c.hits[0].reasons.some(x => /WorkNEX context “ROOTS Procurement”|Folder path/.test(x)));
  assert.deepEqual(c.hits[0].contexts.map(x => x.title), ['ROOTS Procurement']);
});

test('related files: shared WorkNEX context, name family and time beat mere folder neighbours — with reasons', async () => {
  const { engine } = await corpus();
  const deck = engine.store.all().find(f => f.name === 'ISO29110_Executive_v6.pptx')!;
  const rel = await engine.related(deck.id);
  assert.equal(rel[0].file.name, 'ISO29110_Cost.xlsx');
  assert.ok(rel[0].reasons.some(r => r.includes('Used together in WorkNEX context')));
  assert.ok(rel.some(r => r.file.name === 'ISO29110_PreAssessment.docx' && r.reasons.some(x => x.startsWith('Similar name'))));
  assert.ok(!rel.some(r => r.file.name === 'budget.pdf'));
});

test('versions: grouping, likely latest by modification, highest-number note', async () => {
  assert.equal(normalizeStem('proposal_final2.docx'), 'proposal');
  assert.equal(normalizeStem('ISO29110_Executive_v6.pptx'), 'iso29110 executive');
  assert.equal(versionNumber('proposal_v6.docx'), 6);
  assert.equal(versionNumber('spec revB.docx'), 2);
  assert.equal(versionNumber('proposal_final2.docx'), 2);
  const { engine } = await corpus();
  const g = engine.versionGroups().find(x => x.files.some(f => f.name === 'proposal.docx'))!;
  assert.equal(g.files.length, 4);
  assert.equal(engine.store.get(g.latestId)!.name, 'proposal_final2.docx', 'most recently modified');
  assert.equal(engine.store.get(g.highestVersionId!)!.name, 'proposal_v6.docx');
  assert.ok(g.reasons.some(r => r.startsWith('Likely latest')) && g.reasons.some(r => r.includes('highest version number')));
  assert.ok(!g.reasons.some(r => /definitely/i.test(r)));
  assert.equal(buildVersionGroups([]).length, 0);
});

test('duplicates: exact by size + hash (different names), possible by name; nothing is deleted', async () => {
  const { engine, home } = await corpus();
  const d = engine.duplicates();
  const exact = d.find(g => g.kind === 'exact')!;
  assert.deepEqual(exact.files.map(f => f.name).sort(), ['Q3 summary copy.pdf', 'Quarterly Summary.pdf']);
  const possible = d.find(g => g.kind === 'possible' && g.files.some(f => f.name === 'Report.pptx'))!;
  assert.ok(possible.files.some(f => f.name === 'Report Copy.pptx'));
  assert.ok(existsSync(join(home, 'Work/Dup/Report Copy.pptx')));
});

test('safe actions only: open / reveal indexed files; nothing outside the index can be opened', async () => {
  const { engine, opened } = await corpus();
  const f = engine.store.all()[0];
  await engine.open(f.id);
  await engine.reveal(f.id);
  assert.deepEqual(opened, [`open:${f.path}`, `reveal:${f.path}`]);
  await assert.rejects(engine.open('not-an-indexed-id'), /not in the FileNEX index/);
  assert.ok(!('delete' in engine) && !('move' in engine) && !('rename' in engine));
});

test('collections are logical: adding a file never moves it', async () => {
  const { engine } = await corpus();
  const col = engine.createCollection('Q4 ISO29110');
  const f = engine.store.all().find(x => x.name === 'ISO29110_Cost.xlsx')!;
  engine.addToCollection(col.id, f.id);
  const c = await engine.collection(`user:${col.id}`);
  assert.equal(c.files[0].path, f.path);
  assert.equal(c.byType.spreadsheet, 1);
  const work = await engine.collection('context:c-iso');
  assert.deepEqual(work.files.map(x => x.name).sort(), ['ISO29110_Cost.xlsx', 'ISO29110_Executive_v6.pptx']);
});
