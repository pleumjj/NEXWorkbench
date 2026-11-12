import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActivitySource } from '@nex/platform-core';

/** User away longer than this → the front app is not being "used". */
const AWAY_AFTER_MS = 2 * 60_000;
/** Gap in MemNEX's own uptime after which old observations can't be trusted (it wasn't watching). */
const COVERAGE_GAP_MS = 10 * 60_000;

type Persisted = { coverageStart: number; heartbeat: number; lastActive: Record<string, number> };

export type Activity = {
  /** ms timestamp of last foreground use while MemNEX was watching, or null. */
  lastActive: number | null;
  /** true if it is the app in front and the user is present. */
  activeNow: boolean;
  /** Minutes since last use. `atLeast` = never seen in front since coverage began. null = not enough data yet. */
  idleMinutes: number | null;
  atLeast: boolean;
};

/**
 * Local-only usage memory: which app was in front, and when (PRD §6 "Last Activity").
 * Sampling is ~10 ms of work every few seconds. Persisted to one small JSON file; nothing leaves the machine.
 */
export class ActivityTracker {
  private state: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private current: { key: string | null; pid: number | null; present: boolean } = { key: null, pid: null, present: false };
  private lastSave = 0;

  constructor(private readonly file: string | null, now = Date.now()) {
    let saved: Persisted | null = null;
    try { if (file && existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    // If MemNEX was not running for a while, anything could have happened meanwhile: restart coverage.
    const continuous = saved && now - saved.heartbeat < COVERAGE_GAP_MS;
    this.state = { coverageStart: continuous ? saved!.coverageStart : now, heartbeat: now, lastActive: saved?.lastActive ?? {} };
  }

  start(source: ActivitySource, everyMs: number) {
    if (this.timer) return;
    const tick = () => source.activeApp().then(f => this.observe(f.key, f.pid, f.idleMs)).catch(() => {});
    void tick();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.save(true); }

  /** Record one foreground observation (public for tests). */
  observe(key: string | null, pid: number | null, idleMs: number | null, now = Date.now()) {
    const present = idleMs == null || idleMs < AWAY_AFTER_MS;
    this.current = { key, pid, present };
    if (present) {
      if (key) this.state.lastActive[key] = now;
      if (pid) this.state.lastActive[`pid:${pid}`] = now;
    }
    this.state.heartbeat = now;
    this.save();
  }

  /** Test seam. */
  setState(s: Partial<Persisted>, current?: { key: string | null; pid: number | null; present: boolean }) {
    this.state = { ...this.state, ...s };
    if (current) this.current = current;
  }

  private save(force = false) {
    if (!this.file) return;
    const now = Date.now();
    if (!force && now - this.lastSave < 60_000) return;
    this.lastSave = now;
    // pid keys are only meaningful for this boot of the app; keep the file small.
    const cutoff = now - 7 * 86_400_000;
    for (const [k, t] of Object.entries(this.state.lastActive)) if (t < cutoff || (k.startsWith('pid:') && t < now - 86_400_000)) delete this.state.lastActive[k];
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.state)); } catch {}
  }

  /** `key` is bundle id / exe path; `pids` covers apps without one. */
  activityOf(key: string | null, pids: number[], now = Date.now()): Activity {
    const times = [key ? this.state.lastActive[key] : undefined, ...pids.map(p => this.state.lastActive[`pid:${p}`])]
      .filter((t): t is number => typeof t === 'number' && t >= this.state.coverageStart);
    const lastActive = times.length ? Math.max(...times) : null;
    const activeNow = this.current.present && ((!!key && this.current.key === key) || (!!this.current.pid && pids.includes(this.current.pid)));
    const watchedMin = (now - this.state.coverageStart) / 60_000;
    if (activeNow) return { lastActive: now, activeNow, idleMinutes: 0, atLeast: false };
    if (lastActive != null) return { lastActive, activeNow, idleMinutes: (now - lastActive) / 60_000, atLeast: false };
    return { lastActive: null, activeNow, idleMinutes: watchedMin >= 5 ? watchedMin : null, atLeast: true };
  }

  watchingMinutes(now = Date.now()) { return (now - this.state.coverageStart) / 60_000; }
}
