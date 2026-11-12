import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { FileRecord, FileType, FilenexSettings, IndexedLocation } from '../types';
import { DOCUMENT_PACKAGE, allowDir, allowFile, approvedLocationFor } from '../privacy-engine';

const TYPES: [FileType, RegExp][] = [
  ['presentation', /^(ppt|pptx|pptm|key|odp)$/], ['spreadsheet', /^(xls|xlsx|xlsm|xlsb|csv|tsv|numbers|ods)$/],
  ['document', /^(doc|docx|docm|pages|odt|rtf|rtfd)$/], ['pdf', /^pdf$/], ['text', /^(txt|md|markdown|rst|org|tex)$/],
  ['data', /^(json|yaml|yml|xml|toml|ini|sql|sqlite|db|parquet)$/],
  ['code', /^(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|c|cc|cpp|h|hpp|cs|rb|php|swift|kt|kts|scala|sh|zsh|bash|ps1|css|scss|less|html|htm|vue|svelte|dart|lua|r|m|ipynb)$/],
  ['image', /^(png|jpg|jpeg|gif|webp|svg|heic|heif|tif|tiff|bmp|ico|raw|cr2|nef|dng)$/], ['design', /^(fig|sketch|psd|ai|xd|indd|graffle|drawio|afdesign|afphoto)$/],
  ['archive', /^(zip|rar|7z|tar|gz|tgz|bz2|xz|dmg|iso)$/], ['video', /^(mp4|mov|m4v|avi|mkv|webm|wmv)$/], ['audio', /^(mp3|wav|m4a|aac|flac|ogg|aiff)$/],
];
export const typeOf = (ext: string): FileType => TYPES.find(([, re]) => re.test(ext.toLowerCase()))?.[0] ?? 'other';
export const fileId = (path: string) => createHash('sha1').update(process.platform === 'linux' ? path : path.toLowerCase()).digest('hex').slice(0, 16);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type ScanControl = {
  /** Re-checked between batches: false stops the scan immediately (folder removed/paused, FileNEX paused). */
  stillAllowed: () => boolean;
  /** ms to wait between batches (higher under system pressure). */
  throttleMs: () => number;
  onProgress: (scanned: number) => void;
};
export type ScanResult = { records: FileRecord[]; aborted: boolean; errors: number };

/**
 * Walk one approved location. The walk starts inside the location and never follows symlinks out of it;
 * every candidate is re-checked against the allowlist before it becomes a record (defence in depth).
 * Only stat() metadata is read — never file contents.
 */
export async function scanLocation(loc: IndexedLocation, s: FilenexSettings, ctl: ScanControl, batch = 250, max = 250_000): Promise<ScanResult> {
  const records: FileRecord[] = [];
  const stack = [loc.path];
  let seen = 0, errors = 0;
  const now = new Date().toISOString();
  const toRecord = (path: string, st: { size: number; birthtimeMs: number; mtimeMs: number }): FileRecord => {
    const name = basename(path);
    const ext = extname(name).slice(1).toLowerCase();
    return {
      id: fileId(path), name, extension: ext, path, parentPath: dirname(path), locationId: loc.id, sizeBytes: st.size,
      createdAt: st.birthtimeMs > 0 ? new Date(st.birthtimeMs).toISOString() : null, modifiedAt: new Date(st.mtimeMs).toISOString(),
      fileType: typeOf(ext), hash: null, indexedAt: now,
    };
  };
  while (stack.length) {
    if (!ctl.stillAllowed()) return { records, aborted: true, errors };
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { errors++; continue; }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      // The boundary: nothing outside an active approved location can become a record.
      if (!approvedLocationFor(path, s)) continue;
      if (e.isDirectory()) {
        if (DOCUMENT_PACKAGE.test(e.name) && allowFile(e.name, s)) {
          try { const st = await lstat(path); records.push(toRecord(path, { size: 0, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs })); } catch { errors++; }
        } else if (allowDir(e.name, s, loc.excludedFolders)) stack.push(path);
      } else if (e.isFile() && allowFile(e.name, s)) {
        try { records.push(toRecord(path, await stat(path))); } catch { errors++; }
        if (records.length >= max) return { records, aborted: false, errors };
      }
      if (++seen % batch === 0) {
        ctl.onProgress(records.length);
        await sleep(ctl.throttleMs());
        if (!ctl.stillAllowed()) return { records, aborted: true, errors };
      }
    }
  }
  ctl.onProgress(records.length);
  return { records, aborted: false, errors };
}

/** SHA-1 of a file's bytes — only for size-matched duplicate candidates, never for search or indexing. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha1');
    createReadStream(path, { highWaterMark: 1024 * 1024 }).on('data', d => h.update(d)).on('error', reject).on('end', () => resolveHash(h.digest('hex')));
  });
}
