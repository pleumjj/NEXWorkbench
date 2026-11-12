import type { Growth } from '../types';

const SAMPLE_EVERY_MS = 20_000;
const WINDOW_MS = 45 * 60_000;

type Point = { t: number; bytes: number; byPid: Record<number, number> };
type Series = { mainPid: number; points: Point[]; names: Map<number, string> };
export type MemorySample = { id: string; mainPid: number; memory: number; procs: { pid: number; name: string; memory: number }[] };

/** Per-app memory history kept in memory only (45 min window) to detect sustained growth. */
export class MemoryGrowth {
  private readonly series = new Map<string, Series>();

  record(apps: MemorySample[], now = Date.now()) {
    for (const a of apps) {
      let s = this.series.get(a.id);
      // A new main pid means the app restarted: its old curve says nothing about the new instance.
      if (!s || s.mainPid !== a.mainPid) { s = { mainPid: a.mainPid, points: [], names: new Map() }; this.series.set(a.id, s); }
      const last = s.points[s.points.length - 1];
      if (last && now - last.t < SAMPLE_EVERY_MS) continue;
      const byPid: Record<number, number> = {};
      for (const p of a.procs) { byPid[p.pid] = p.memory; s.names.set(p.pid, p.name); }
      s.points.push({ t: now, bytes: a.memory, byPid });
      s.points = s.points.filter(p => now - p.t <= WINDOW_MS);
    }
    for (const id of this.series.keys()) if (!apps.some(a => a.id === id)) this.series.delete(id);
  }

  /** Test seam: replace an app's series. */
  setSeries(id: string, mainPid: number, points: Point[], names: Record<number, string> = {}) {
    this.series.set(id, { mainPid, points, names: new Map(Object.entries(names).map(([k, v]) => [Number(k), v])) });
  }

  /**
   * Sustained growth, not a spike: grew ≥ 500 MB and ≥ 30 % above its low point over ≥ 10 min,
   * and the recent samples stay high (so a single burst that already settled doesn't count).
   */
  growthOf(id: string): Growth | null {
    const s = this.series.get(id);
    const pts = s?.points ?? [];
    if (pts.length < 6) return null;
    const minIdx = pts.reduce((m, p, i) => (p.bytes < pts[m].bytes ? i : m), 0);
    const low = pts[minIdx], now = pts[pts.length - 1];
    const minutes = (now.t - low.t) / 60_000;
    const grew = now.bytes - low.bytes;
    if (minutes < 10 || grew < 500 * 1024 ** 2 || now.bytes < low.bytes * 1.3) return null;
    if (pts.slice(-3).some(p => p.bytes < low.bytes + grew * 0.7)) return null;
    // Which process inside the app accounts for it (a renderer, an extension host…) — new pids count from zero.
    let top: Growth['top'] = null;
    for (const [pidStr, bytes] of Object.entries(now.byPid)) {
      const pid = Number(pidStr), delta = bytes - (low.byPid[pid] ?? 0);
      if (!top || delta > top.bytes) top = { pid, name: s!.names.get(pid) ?? `PID ${pid}`, bytes: delta };
    }
    return { bytes: grew, minutes: Math.round(minutes), top: top && top.bytes >= grew * 0.4 ? top : null };
  }
}
