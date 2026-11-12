import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocationAnalysis, RepoStorageSnapshot, StorageCategorySnapshot, StorageForecast, StorageSnapshot } from '../storage-types';

const DAY = 86_400_000, WEEK = 7 * DAY;

/**
 * Local storage history: lightweight periodic snapshots (about one per hour, kept for the retention period) plus the
 * latest analysis of each approved location. Never file contents; clearing it never touches any file.
 */
export class StorageHistory {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS filenex_storage_snapshots (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, total INTEGER NOT NULL, used INTEGER NOT NULL, free INTEGER NOT NULL, categories TEXT);
      CREATE INDEX IF NOT EXISTS filenex_storage_snapshots_ts ON filenex_storage_snapshots(ts);
      CREATE TABLE IF NOT EXISTS filenex_repo_storage_snapshots (
        project_id TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, total INTEGER NOT NULL, source INTEGER NOT NULL,
        dependency INTEGER NOT NULL, build INTEGER NOT NULL, cache INTEGER NOT NULL, logs INTEGER NOT NULL, git INTEGER NOT NULL, other INTEGER NOT NULL,
        PRIMARY KEY (project_id, ts));
      CREATE TABLE IF NOT EXISTS filenex_storage_analysis (location_id TEXT PRIMARY KEY, analyzed_at INTEGER NOT NULL, json TEXT NOT NULL);
    `);
  }

  addSnapshot(s: StorageSnapshot) {
    this.db.prepare('INSERT OR REPLACE INTO filenex_storage_snapshots (id, ts, total, used, free, categories) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, Date.parse(s.timestamp), s.totalBytes, s.usedBytes, s.freeBytes, s.categories ? JSON.stringify(s.categories) : null);
  }
  snapshots(sinceMs = 0): StorageSnapshot[] {
    return (this.db.prepare('SELECT * FROM filenex_storage_snapshots WHERE ts >= ? ORDER BY ts').all(sinceMs) as any[]).map(r => ({
      id: r.id, timestamp: new Date(Number(r.ts)).toISOString(), totalBytes: Number(r.total), usedBytes: Number(r.used), freeBytes: Number(r.free),
      categories: r.categories ? JSON.parse(r.categories) as StorageCategorySnapshot[] : undefined,
    }));
  }
  lastSnapshotAt(): number | null { const r = this.db.prepare('SELECT MAX(ts) AS ts FROM filenex_storage_snapshots').get() as { ts: number | null }; return r?.ts != null ? Number(r.ts) : null; }

  addRepoSnapshots(rows: RepoStorageSnapshot[]) {
    if (!rows.length) return;
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO filenex_repo_storage_snapshots (project_id, ts, name, total, source, dependency, build, cache, logs, git, other)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.tx(() => { for (const r of rows) stmt.run(r.projectId, Date.parse(r.timestamp), r.name, r.totalBytes, r.sourceBytes, r.dependencyBytes, r.buildBytes, r.cacheBytes, r.logBytes, r.gitBytes, r.otherBytes); });
  }
  repoSnapshots(sinceMs = 0, projectId?: string): RepoStorageSnapshot[] {
    const rows = (projectId
      ? this.db.prepare('SELECT * FROM filenex_repo_storage_snapshots WHERE ts >= ? AND project_id = ? ORDER BY ts').all(sinceMs, projectId)
      : this.db.prepare('SELECT * FROM filenex_repo_storage_snapshots WHERE ts >= ? ORDER BY ts').all(sinceMs)) as any[];
    return rows.map(r => ({
      projectId: r.project_id, name: r.name, timestamp: new Date(Number(r.ts)).toISOString(), totalBytes: Number(r.total), sourceBytes: Number(r.source),
      dependencyBytes: Number(r.dependency), buildBytes: Number(r.build), cacheBytes: Number(r.cache), logBytes: Number(r.logs), gitBytes: Number(r.git), otherBytes: Number(r.other),
    }));
  }

  saveAnalysis(a: LocationAnalysis) {
    this.db.prepare('INSERT OR REPLACE INTO filenex_storage_analysis (location_id, analyzed_at, json) VALUES (?, ?, ?)').run(a.locationId, Date.parse(a.analyzedAt), JSON.stringify(a));
  }
  analyses(): LocationAnalysis[] {
    return (this.db.prepare('SELECT json FROM filenex_storage_analysis').all() as { json: string }[]).flatMap(r => { try { return [JSON.parse(r.json) as LocationAnalysis]; } catch { return []; } });
  }
  deleteAnalysis(locationId: string) { this.db.prepare('DELETE FROM filenex_storage_analysis WHERE location_id = ?').run(locationId); }

  /** Retention: drop snapshots older than N days. */
  prune(retentionDays: number, now = Date.now()) {
    const cut = now - retentionDays * DAY;
    this.db.prepare('DELETE FROM filenex_storage_snapshots WHERE ts < ?').run(cut);
    this.db.prepare('DELETE FROM filenex_repo_storage_snapshots WHERE ts < ?').run(cut);
  }
  /** Deletes storage history (and optionally the cached analyses). Never touches real files. */
  clear(includeAnalyses = true) {
    this.tx(() => {
      this.db.exec('DELETE FROM filenex_storage_snapshots; DELETE FROM filenex_repo_storage_snapshots;');
      if (includeAnalyses) this.db.exec('DELETE FROM filenex_storage_analysis;');
    });
  }
  counts() {
    const n = (t: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    return { snapshots: n('filenex_storage_snapshots'), repoSnapshots: n('filenex_repo_storage_snapshots'), analyses: n('filenex_storage_analysis') };
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  private tx(fn: () => void) {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

/* ───────────── Pure calculations (tested) ───────────── */

export interface GrowthResult {
  days: number;
  from: string;
  to: string;
  usedDeltaBytes: number;
  breakdown: { key: string; label: string; kind: StorageCategorySnapshot['kind']; deltaBytes: number }[];
  /** usedDelta minus the attributed categories: growth outside analyzed folders (or not attributable). */
  otherDeltaBytes: number;
  attributed: boolean;
}

/**
 * What grew over the last `days`: disk used delta from the snapshot nearest the window start, broken down by the
 * categories present in both categorized snapshots (a newly added folder is not "growth"). Null without ≥ 1 day of history.
 */
export function storageGrowth(snaps: StorageSnapshot[], now: number, days: number): GrowthResult | null {
  if (snaps.length < 2) return null;
  const start = now - days * DAY;
  const sorted = [...snaps].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const last = sorted[sorted.length - 1];
  const inWindow = sorted.filter(s => Date.parse(s.timestamp) >= start - DAY);
  const first = inWindow[0];
  if (!first || first === last || Date.parse(last.timestamp) - Date.parse(first.timestamp) < DAY) return null;
  const cats = inWindow.filter(s => s.categories?.length);
  const a = cats[0], b = cats[cats.length - 1];
  const breakdown: GrowthResult['breakdown'] = [];
  if (a && b && a !== b) {
    const before = new Map(a.categories!.map(c => [c.key, c]));
    for (const c of b.categories!) {
      const old = before.get(c.key);
      if (!old) continue;
      const d = c.bytes - old.bytes;
      if (d !== 0) breakdown.push({ key: c.key, label: c.label, kind: c.kind, deltaBytes: d });
    }
  }
  // Locations and repos overlap (a repo is inside a location): attribute with the outermost level only.
  const top = breakdown.filter(x => x.kind !== 'repo' && x.kind !== 'folder');
  const usedDelta = last.usedBytes - first.usedBytes;
  return {
    days, from: first.timestamp, to: last.timestamp, usedDeltaBytes: usedDelta,
    breakdown: breakdown.sort((x, y) => Math.abs(y.deltaBytes) - Math.abs(x.deltaBytes)),
    otherDeltaBytes: usedDelta - top.reduce((n, x) => n + x.deltaBytes, 0),
    attributed: !!(a && b && a !== b),
  };
}

/**
 * Linear trend of used space over the last 28 days (least squares). Needs ≥ 4 snapshots spanning ≥ 3 days.
 * No AI, no seasonality — a rough, explainable estimate.
 */
export function storageForecast(snaps: StorageSnapshot[], now: number, totalBytes: number): StorageForecast {
  const pts = snaps.filter(s => Date.parse(s.timestamp) >= now - 28 * DAY).map(s => ({ x: Date.parse(s.timestamp), y: s.usedBytes }));
  const span = pts.length ? (pts[pts.length - 1].x - pts[0].x) : 0;
  if (pts.length < 4 || span < 3 * DAY) return { enough: false, message: 'Not enough history to estimate.' };
  const mx = pts.reduce((n, p) => n + p.x, 0) / pts.length, my = pts.reduce((n, p) => n + p.y, 0) / pts.length;
  const num = pts.reduce((n, p) => n + (p.x - mx) * (p.y - my), 0), den = pts.reduce((n, p) => n + (p.x - mx) ** 2, 0);
  const slope = den ? num / den : 0; // bytes per ms
  const rate = slope * WEEK;
  const used = pts[pts.length - 1].y;
  const basisDays = Math.round(span / DAY);
  if (rate < 0.25 * 1024 ** 3) {
    return { enough: true, ratePerWeekBytes: rate, weeksTo90: null, weeksToFull: null, basisDays, message: rate < 0 ? 'Storage use is going down.' : 'Storage use is stable.' };
  }
  const to90 = 0.9 * totalBytes - used, toFull = totalBytes - used;
  const weeksTo90 = to90 > 0 ? to90 / rate : 0, weeksToFull = toFull / rate;
  const fmt = (w: number) => (w < 1 ? `~${Math.max(1, Math.round(w * 7))} days` : `~${Math.round(w)} week${Math.round(w) === 1 ? '' : 's'}`);
  return {
    enough: true, ratePerWeekBytes: rate, weeksTo90: to90 > 0 ? weeksTo90 : null, weeksToFull, basisDays,
    message: to90 > 0 ? `Disk may reach 90% usage in ${fmt(weeksTo90)}.` : `Disk is above 90% used — it may fill up in ${fmt(weeksToFull)}.`,
  };
}

/** Repo growth over `days` from its snapshots (oldest in window vs latest). Null without two snapshots ≥ 1 day apart. */
export function repoGrowth(rows: RepoStorageSnapshot[], now: number, days: number) {
  const inWin = rows.filter(r => Date.parse(r.timestamp) >= now - days * DAY - DAY).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (inWin.length < 2) return null;
  const a = inWin[0], b = inWin[inWin.length - 1];
  if (Date.parse(b.timestamp) - Date.parse(a.timestamp) < DAY) return null;
  const parts = [
    { key: 'dependencies', label: 'Dependencies', deltaBytes: b.dependencyBytes - a.dependencyBytes },
    { key: 'build', label: 'Build output', deltaBytes: b.buildBytes - a.buildBytes },
    { key: 'cache', label: 'Caches', deltaBytes: b.cacheBytes - a.cacheBytes },
    { key: 'logs', label: 'Logs', deltaBytes: b.logBytes - a.logBytes },
    { key: 'git', label: 'Git', deltaBytes: b.gitBytes - a.gitBytes },
    { key: 'source', label: 'Source', deltaBytes: b.sourceBytes - a.sourceBytes },
    { key: 'other', label: 'Other', deltaBytes: b.otherBytes - a.otherBytes },
  ].filter(p => p.deltaBytes !== 0).sort((x, y) => y.deltaBytes - x.deltaBytes);
  return { from: a.timestamp, to: b.timestamp, fromBytes: a.totalBytes, toBytes: b.totalBytes, deltaBytes: b.totalBytes - a.totalBytes, parts };
}
