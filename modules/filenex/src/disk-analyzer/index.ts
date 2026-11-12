import { readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { DiskVolume, StorageForecast, StorageHealth, StorageThresholds } from '../storage-types';

/**
 * Disk capacity from the operating system (statfs) — no folder is read, so this needs no FileNEX permission.
 * macOS APFS: total/free are those of the APFS container; "free" excludes purgeable space, so Finder may show more.
 */
export type StatFs = (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
const defaultStatFs: StatFs = p => statfs(p);

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);

async function volumeAt(path: string, label: string, primary: boolean, fs: StatFs): Promise<DiskVolume | null> {
  try {
    const s = await withTimeout(fs(path), 2000);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    if (!totalBytes) return null;
    return { path, label, totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), primary };
  } catch { return null; }
}

/** The boot/home volume plus mounted local volumes (macOS /Volumes, Windows drive letters). */
export async function diskVolumes(home: string, fs: StatFs = defaultStatFs, platform = process.platform): Promise<DiskVolume[]> {
  const out: DiskVolume[] = [];
  if (platform === 'darwin') {
    let bootName = 'Macintosh HD';
    const others: string[] = [];
    try {
      for (const name of readdirSync('/Volumes')) {
        const p = join('/Volumes', name);
        try {
          if (lstatSync(p).isSymbolicLink()) { if (readlinkSync(p) === '/') bootName = name; }
          else if (!name.startsWith('.') && !/^(Recovery|Preboot|VM|Update|com\.apple)/i.test(name)) others.push(p);
        } catch { /* unreadable mount */ }
      }
    } catch { /* no /Volumes */ }
    const main = await volumeAt(home, bootName, true, fs);
    if (main) out.push(main);
    for (const p of others.slice(0, 12)) { const v = await volumeAt(p, p.slice('/Volumes/'.length), false, fs); if (v) out.push(v); }
  } else if (platform === 'win32') {
    const root = parse(home).root || 'C:\\';
    const main = await volumeAt(root, root.replace(/\\$/, ''), true, fs);
    if (main) out.push(main);
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\`;
      if (p.toLowerCase() === root.toLowerCase()) continue;
      const v = await volumeAt(p, `${letter}:`, false, fs);
      if (v) out.push(v);
    }
  } else {
    const main = await volumeAt(home, '/', true, fs);
    if (main) out.push(main);
  }
  return out;
}

const GB = 1024 ** 3;
export const DEFAULT_THRESHOLDS: StorageThresholds = {
  attention: { gb: 50, percent: 15 },
  low: { gb: 25, percent: 8 },
  critical: { gb: 10, percent: 3 },
};
/** Free-space floor for a level: GB on large disks, a share of the disk on small ones (whichever is lower). */
export const floorBytes = (t: { gb: number; percent: number }, totalBytes: number) => Math.min(t.gb * GB, (t.percent / 100) * totalBytes);

/**
 * Deterministic status. Considers disk size, free space, % free and the recent trend — not a single percentage.
 *   Critical   free below the critical floor
 *   Low        free below the low floor, or the trend reaches the critical floor within 2 weeks
 *   Attention  free below the attention floor, or the trend reaches the low floor within 4 weeks
 *   Healthy    otherwise
 */
export function storageHealth(v: Pick<DiskVolume, 'totalBytes' | 'freeBytes'>, t: StorageThresholds, forecast?: StorageForecast | null): { status: StorageHealth; reasons: string[] } {
  const free = v.freeBytes, total = v.totalBytes;
  const pct = total ? (free / total) * 100 : 0;
  const reasons: string[] = [`${(free / GB).toFixed(1)} GB free (${pct.toFixed(0)}% of ${(total / GB).toFixed(0)} GB)`];
  const rate = forecast?.enough && forecast.ratePerWeekBytes && forecast.ratePerWeekBytes > 0 ? forecast.ratePerWeekBytes : 0;
  const weeksUntil = (floor: number) => (rate ? Math.max(0, (free - floor) / rate) : Infinity);
  const crit = floorBytes(t.critical, total), low = floorBytes(t.low, total), att = floorBytes(t.attention, total);
  if (free < crit) return { status: 'critical', reasons: [...reasons, `Below the critical level (${(crit / GB).toFixed(0)} GB) — apps and updates may fail`] };
  if (free < low) return { status: 'low', reasons: [...reasons, `Below the low-space level (${(low / GB).toFixed(0)} GB)`] };
  if (weeksUntil(crit) < 2) return { status: 'low', reasons: [...reasons, `At the recent rate (+${(rate / GB).toFixed(1)} GB/week) free space reaches the critical level within 2 weeks`] };
  if (free < att) return { status: 'attention', reasons: [...reasons, `Below the attention level (${(att / GB).toFixed(0)} GB)`] };
  if (weeksUntil(low) < 4) return { status: 'attention', reasons: [...reasons, `Free space is trending down (+${(rate / GB).toFixed(1)} GB/week used)`] };
  return { status: 'healthy', reasons };
}
