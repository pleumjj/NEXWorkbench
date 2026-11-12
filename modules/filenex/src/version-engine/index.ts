import { basename, dirname } from 'node:path';
import type { FileRecord, VersionGroup } from '../types';

/**
 * Version intelligence: proposal.docx, proposal_final.docx, proposal_final2.docx, proposal_v6.docx → one group.
 * Deterministic and humble: we say "Likely latest", never "the latest".
 */

const VERSION_TOKENS = /(?:^|[\s._\-()])(?:v|ver|version|rev|r)\s?\.?\s?(\d+(?:\.\d+)*|[a-z])(?=$|[\s._\-()])|(?:^|[\s._\-()])(?:final|latest|new|updated|draft|copy|edited|revised|clean|fixed)(?:\s?\d+)?(?=$|[\s._\-()])|\(\d+\)|(?:^|[\s._\-])\d{4}[-_.]?\d{2}[-_.]?\d{2}(?=$|[\s._\-])| \d+$/gi;

/** "ISO29110_Executive_v6" → "iso29110 executive"; "proposal final2" → "proposal". */
export function normalizeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.replace(VERSION_TOKENS, ' ').replace(/[\s._\-()]+/g, ' ').trim().toLowerCase();
}

/** Numeric version from a name (v6 → 6, rev B → 2, final2 → 2, final → 1). null when the name carries none. */
export function versionNumber(name: string): number | null {
  const stem = name.replace(/\.[^.]+$/, '');
  const v = stem.match(/(?:^|[\s._\-])(?:v|ver|version)\s?\.?\s?(\d+(?:\.\d+)?)(?=$|[\s._\-])/i);
  if (v) return Number(v[1]);
  const rev = stem.match(/(?:^|[\s._\-])rev\s?([a-z]|\d+)(?=$|[\s._\-])/i);
  if (rev) return /\d/.test(rev[1]) ? Number(rev[1]) : rev[1].toLowerCase().charCodeAt(0) - 96;
  const fin = stem.match(/(?:^|[\s._\-])final\s?(\d*)(?=$|[\s._\-])/i);
  if (fin) return fin[1] ? Number(fin[1]) : 1;
  return null;
}

/** Archive-like subfolders count as the same place ("Reports/old/report_v2.docx" belongs with "Reports/report_v3.docx"). */
const ARCHIVE_DIR = /^(old|archive|archived|backup|backups|previous|versions?|history|_old)$/i;
const place = (f: FileRecord) => (ARCHIVE_DIR.test(basename(f.parentPath)) ? dirname(f.parentPath) : f.parentPath);

export function buildVersionGroups(files: FileRecord[]): VersionGroup[] {
  const groups = new Map<string, FileRecord[]>();
  for (const f of files) {
    if (f.fileType === 'code' || f.fileType === 'other' && !f.extension) continue;
    const stem = normalizeStem(f.name);
    if (stem.length < 3) continue;
    const key = `${place(f).toLowerCase()}|${stem}|${f.extension}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: VersionGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    // A group only exists if names actually differ by version-like tokens (identical names in archive folders included).
    const byTime = [...list].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    const latest = byTime[0];
    const numbered = list.map(f => ({ f, v: versionNumber(f.name) })).filter(x => x.v != null);
    const highest = numbered.length ? numbered.sort((a, b) => b.v! - a.v!)[0].f : null;
    const reasons = [`${list.length} files share the name “${normalizeStem(latest.name)}” apart from version words or numbers`, `Likely latest: ${latest.name} — most recently modified`];
    if (highest && highest.id !== latest.id) reasons.push(`Note: ${highest.name} has the highest version number, but ${latest.name} was modified more recently`);
    out.push({ key, label: latest.name, files: byTime, latestId: latest.id, highestVersionId: highest?.id ?? null, reasons });
  }
  return out.sort((a, b) => Date.parse(b.files[0].modifiedAt) - Date.parse(a.files[0].modifiedAt));
}

/** Map fileId → its group (for search hints and the detail page). */
export const versionIndex = (groups: VersionGroup[]) => new Map(groups.flatMap(g => g.files.map(f => [f.id, g] as const)));
