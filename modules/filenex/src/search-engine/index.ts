import type { FileRecord, FileType, ParsedQuery, ProjectRef, SearchHit, WorkContextRef } from '../types';
import { contextsOf, projectOf } from '../relationship-engine';

/**
 * Search that works around human memory — deterministic, explainable, local. No LLM.
 * "presentation edited yesterday" → type=presentation, modified=yesterday.
 * "excel from ISO29110"           → type=spreadsheet, terms=[iso29110] (matches names, paths, projects, WorkNEX contexts).
 */

const TYPE_WORDS: [FileType, RegExp][] = [
  ['presentation', /^(presentations?|slides?|decks?|ppt|pptx|keynote|powerpoint)$/],
  ['spreadsheet', /^(excel|spreadsheets?|sheets?|xlsx?|csv|numbers|workbooks?)$/],
  ['document', /^(word|docs?|documents?|docx|pages|reports?)$/],
  ['pdf', /^pdfs?$/],
  ['image', /^(images?|photos?|pictures?|pics?|png|jpe?g|screenshots?)$/],
  ['code', /^(code|source|scripts?)$/],
  ['text', /^(notes?|markdown|md|txt|text)$/],
  ['design', /^(designs?|figma|sketch|psd)$/],
  ['video', /^(videos?|movies?|recordings?)$/],
];
const STOP = new Set(['from', 'in', 'for', 'the', 'a', 'an', 'of', 'my', 'file', 'files', 'modified', 'edited', 'changed', 'updated', 'created', 'with', 'about', 'on', 'to', 'and', 'that', 'i', 'worked', 'used', 'recent', 'recently', 'latest']);

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Pull type and date hints out of a free-text query; what's left are search terms. */
export function parseQuery(q: string, now = new Date()): ParsedQuery {
  const words = q.toLowerCase().replace(/[“”"']/g, ' ').split(/\s+/).filter(Boolean);
  const interpreted: string[] = [];
  let type: FileType | null = null, from: number | null = null, to: number | null = null;
  const terms: string[] = [];
  const today = startOfDay(now), DAY = 86_400_000;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = words[i + 1];
    const t = TYPE_WORDS.find(([, re]) => re.test(w));
    if (t && !type) { type = t[0]; interpreted.push(`type: ${t[0]}`); continue; }
    if (w === 'today') { from = today; interpreted.push('modified: today'); continue; }
    if (w === 'yesterday') { from = today - DAY; to = today; interpreted.push('modified: yesterday'); continue; }
    if ((w === 'this' || w === 'last') && (next === 'week' || next === 'month')) {
      const monday = today - ((now.getDay() + 6) % 7) * DAY;
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      if (next === 'week') { from = w === 'this' ? monday : monday - 7 * DAY; to = w === 'this' ? null : monday; }
      else { from = w === 'this' ? firstOfMonth : new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(); to = w === 'this' ? null : firstOfMonth; }
      interpreted.push(`modified: ${w} ${next}`); i++; continue;
    }
    if (w === 'last' && /^\d+$/.test(next ?? '') && /^days?$/.test(words[i + 2] ?? '')) { from = today - (Number(next) - 1) * DAY; interpreted.push(`modified: last ${next} days`); i += 2; continue; }
    if (w === 'recent' || w === 'recently') { if (from == null) { from = today - 6 * DAY; interpreted.push('modified: last 7 days'); } continue; }
    if (STOP.has(w)) continue;
    terms.push(w.replace(/[^\p{L}\p{N}._-]/gu, '')); 
  }
  return { terms: terms.filter(Boolean), type, modifiedFrom: from, modifiedTo: to, interpreted };
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Damerau-free Levenshtein ≤ 1 (one typo) for words ≥ 5 chars. */
function oneEdit(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1 || a.length < 5) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export type SearchFilters = { type?: FileType | null; modifiedFrom?: number | null; modifiedTo?: number | null; locationId?: string | null; projectId?: string | null; contextId?: string | null };

/**
 * Rank files for a query. Every point comes with a reason (shown as "Why this result?").
 * At least ~60 % of the terms must match somewhere (name, path, project, WorkNEX context) — forgiving, not random.
 */
export function search(files: FileRecord[], q: string, ctx: { contexts: WorkContextRef[]; projects: ProjectRef[]; latest?: Map<string, 'latest' | 'older'>; now?: Date }, filters: SearchFilters = {}, limit = 60): { hits: SearchHit[]; parsed: ParsedQuery; total: number } {
  const now = ctx.now ?? new Date();
  const parsed = parseQuery(q, now);
  const type = filters.type ?? parsed.type;
  const from = filters.modifiedFrom ?? parsed.modifiedFrom, to = filters.modifiedTo ?? parsed.modifiedTo;
  const phrase = parsed.terms.join(' ');
  const recentCtx = ctx.contexts.filter(c => now.getTime() - Date.parse(c.lastActiveAt) <= 7 * 86_400_000);
  const hits: SearchHit[] = [];
  for (const f of files) {
    if (type && f.fileType !== type) continue;
    const m = Date.parse(f.modifiedAt);
    if (from != null && m < from) continue;
    if (to != null && m >= to) continue;
    if (filters.locationId && f.locationId !== filters.locationId) continue;
    const project = projectOf(f, ctx.projects);
    if (filters.projectId && project?.id !== filters.projectId) continue;
    const fctx = contextsOf(f, ctx.contexts);
    if (filters.contextId && !fctx.some(c => c.id === filters.contextId)) continue;

    let score = 0, matched = 0;
    const reasons: string[] = [];
    const nameL = f.name.toLowerCase(), nameW = words(f.name), pathL = f.parentPath.toLowerCase();
    if (phrase.length >= 3 && nameL.includes(phrase)) { score += 30; reasons.push(`Filename contains “${phrase}”`); }
    for (const t of parsed.terms) {
      let hit = false;
      if (nameW.some(w => w === t)) { score += 14; hit = true; if (!reasons.some(r => r.startsWith('Filename contains'))) reasons.push(`Filename matches “${t}”`); }
      else if (nameW.some(w => w.startsWith(t)) || (t.length >= 3 && nameL.includes(t))) { score += 9; hit = true; reasons.push(`Filename contains “${t}”`); }
      else if (nameW.some(w => oneEdit(w, t))) { score += 4; hit = true; reasons.push(`Filename is close to “${t}”`); }
      if (project && words(project.name).some(w => w.startsWith(t))) { score += 7; if (!hit) reasons.push(`In DevNEX project “${project.name}”`); hit = true; }
      const c = fctx.find(x => words(x.title).some(w => w.startsWith(t)));
      if (c) { score += 9; if (!hit) reasons.push(`Used in WorkNEX context “${c.title}”`); hit = true; }
      if (!hit && pathL.includes(t)) { score += 4; hit = true; reasons.push(`Folder path contains “${t}”`); }
      if (hit) matched++;
    }
    const need = parsed.terms.length ? Math.max(1, Math.ceil(parsed.terms.length * 0.6)) : 0;
    if (matched < need) continue;
    // Recency and recent work make "the one I was just using" float up.
    const ageDays = (now.getTime() - m) / 86_400_000;
    if (ageDays <= 1) { score += 6; reasons.push('Modified in the last day'); }
    else if (ageDays <= 7) { score += 3; reasons.push('Modified this week'); }
    else if (ageDays <= 30) score += 1;
    const recent = fctx.find(c => recentCtx.includes(c));
    if (recent) { score += 5; if (!reasons.some(r => r.includes(recent.title))) reasons.push(`Used recently in WorkNEX context “${recent.title}”`); }
    const hint = ctx.latest?.get(f.id) ?? null;
    if (hint === 'latest') { score += 2; reasons.push('Likely latest version in its group'); }
    if (hint === 'older') score -= 3;
    if (type && !parsed.terms.length) reasons.push(`Type: ${type}`);
    hits.push({ file: f, score, reasons: [...new Set(reasons)], project, contexts: fctx.map(c => ({ id: c.id, title: c.title })), latestHint: hint });
  }
  hits.sort((a, b) => b.score - a.score || Date.parse(b.file.modifiedAt) - Date.parse(a.file.modifiedAt));
  return { hits: hits.slice(0, limit), parsed, total: hits.length };
}
