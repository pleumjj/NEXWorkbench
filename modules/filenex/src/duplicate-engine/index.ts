import type { DuplicateGroup, FileRecord } from '../types';

/**
 * Duplicates — never deleted, only shown.
 *  exact:    same size AND same content hash (hashes are computed only for size-matched candidates).
 *  possible: same normalized name + extension, and same size or modified within 2 minutes ("Report.pptx" / "Report Copy.pptx").
 */

/** Files worth hashing: ≥ 2 files of exactly the same size (and small enough to hash cheaply). */
export function hashCandidates(files: FileRecord[], maxBytes = 256 * 1024 ** 2): FileRecord[] {
  const bySize = new Map<number, FileRecord[]>();
  for (const f of files) if (f.sizeBytes > 0 && f.sizeBytes <= maxBytes) bySize.set(f.sizeBytes, [...(bySize.get(f.sizeBytes) ?? []), f]);
  return [...bySize.values()].filter(g => g.length > 1).flat();
}

const COPY = /(?:[\s._-]*(?:copy|kopie|copie|copia)(?:\s*\d+)?|\s\(\d+\)|\s\d+)$/i;
const dupStem = (name: string) => name.replace(/\.[^.]+$/, '').replace(COPY, '').toLowerCase().trim();

export function buildDuplicateGroups(files: FileRecord[]): DuplicateGroup[] {
  const out: DuplicateGroup[] = [];
  const inExact = new Set<string>();
  const byHash = new Map<string, FileRecord[]>();
  for (const f of files) if (f.hash) byHash.set(`${f.sizeBytes}:${f.hash}`, [...(byHash.get(`${f.sizeBytes}:${f.hash}`) ?? []), f]);
  for (const [key, list] of byHash) {
    if (list.length < 2) continue;
    list.forEach(f => inExact.add(f.id));
    out.push({ kind: 'exact', key: `exact:${key}`, files: list, reasons: [`Identical content (same size and SHA-1) in ${list.length} places`] });
  }
  const byName = new Map<string, FileRecord[]>();
  for (const f of files) {
    if (inExact.has(f.id) || f.fileType === 'code') continue;
    const stem = dupStem(f.name);
    if (stem.length < 3) continue;
    byName.set(`${stem}|${f.extension}`, [...(byName.get(`${stem}|${f.extension}`) ?? []), f]);
  }
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    const sameSize = new Set(list.map(f => f.sizeBytes)).size === 1;
    const times = list.map(f => Date.parse(f.modifiedAt));
    const close = Math.max(...times) - Math.min(...times) <= 2 * 60_000;
    const copyNamed = list.some(f => COPY.test(f.name.replace(/\.[^.]+$/, '')));
    if (!sameSize && !close && !copyNamed) continue;
    const reasons = ['Same name apart from “copy” / numbering'];
    if (sameSize) reasons.push('Same size'); if (close) reasons.push('Modified within 2 minutes of each other');
    out.push({ kind: 'possible', key: `possible:${key}`, files: list.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)), reasons });
  }
  return out;
}
