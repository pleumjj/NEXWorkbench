import { basename } from 'node:path';
import type { Collection, FileRecord, ProjectRef, RelatedFile, WorkContextRef } from '../types';
import { isInside } from '../privacy-engine';

/**
 * Related files, with reasons. Signals: used together in a WorkNEX context, same collection, same name family,
 * modified close together, same folder, same DevNEX project. Score is additive; weak signals alone don't qualify.
 */

/** Leading token of a file name, ≥ 4 chars and not generic: ISO29110_Executive_v6.pptx → iso29110. */
const GENERIC = new Set(['untitled', 'document', 'copy', 'final', 'draft', 'presentation', 'report', 'notes', 'image', 'screenshot', 'scan', 'file', 'export', 'data', 'readme', 'index', 'main', 'test', 'meeting', 'version', 'new', 'book', 'sheet', 'slides', 'img', 'photo']);
export function familyOf(name: string): string | null {
  const token = name.replace(/\.[^.]+$/, '').split(/[_\-\s.()[\]]+/).find(Boolean) ?? '';
  if (token.length < 4 || !/[a-z]/i.test(token) || GENERIC.has(token.toLowerCase()) || /^\d+$/.test(token)) return null;
  return token.toLowerCase();
}

/** WorkNEX contexts a file belongs to: by exact path, or by file name when WorkNEX only saw the name. */
export function contextsOf(f: FileRecord, contexts: WorkContextRef[]): WorkContextRef[] {
  return contexts.filter(c => c.files.some(x => (x.path ? x.path === f.path : x.name.toLowerCase() === f.name.toLowerCase())));
}
export const projectOf = (f: FileRecord, projects: ProjectRef[]) => [...projects].sort((a, b) => b.path.length - a.path.length).find(p => isInside(f.path, p.path)) ?? null;

export function relatedFiles(target: FileRecord, all: FileRecord[], ctx: { contexts: WorkContextRef[]; projects: ProjectRef[]; collections: Collection[]; versionIds: Set<string> }, limit = 12): RelatedFile[] {
  const tContexts = contextsOf(target, ctx.contexts);
  const tProject = projectOf(target, ctx.projects);
  const tFamily = familyOf(target.name);
  const tCols = ctx.collections.filter(c => c.fileIds.includes(target.id));
  const tTime = Date.parse(target.modifiedAt);
  const out: RelatedFile[] = [];
  for (const f of all) {
    if (f.id === target.id || ctx.versionIds.has(f.id)) continue;
    let score = 0, strong = false;
    const reasons: string[] = [];
    const shared = contextsOf(f, tContexts);
    if (shared.length) { score += 5; strong = true; reasons.push(`Used together in WorkNEX context “${shared[0].title}”`); }
    const col = tCols.find(c => c.fileIds.includes(f.id));
    if (col) { score += 4; strong = true; reasons.push(`Both in your collection “${col.name}”`); }
    if (tFamily && familyOf(f.name) === tFamily) { score += 3; strong = true; reasons.push(`Similar name — both start with “${basename(target.name).split(/[_\-\s.]/)[0]}”`); }
    const dt = Math.abs(Date.parse(f.modifiedAt) - tTime);
    const close = dt <= 30 * 60_000;
    if (close) { score += 2; reasons.push(`Modified within ${Math.max(1, Math.round(dt / 60_000))} min of each other`); }
    const sameFolder = f.parentPath === target.parentPath;
    if (sameFolder) { score += 2; reasons.push('Same folder'); }
    if (tProject && projectOf(f, [tProject])) { score += 1; reasons.push(`Same DevNEX project “${tProject.name}”`); }
    // Weak signals (time, project) never qualify alone: a strong signal, or changed together in the same folder.
    if (strong || (close && sameFolder)) out.push({ file: f, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || Date.parse(b.file.modifiedAt) - Date.parse(a.file.modifiedAt)).slice(0, limit);
}
