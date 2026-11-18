import { join } from 'node:path';
import { JsonFile } from '@nex/config';
import type { PlatformAdapter } from '@nex/platform-core';
import { AgentTracker, type AgentOverview, type AgentSessionRecord, type Snapshot, type ViewContext } from './index';

export type AgentMonitorOptions = {
  platform: Pick<PlatformAdapter, 'listProcesses' | 'listeningPorts' | 'processCwds'>;
  dataDir: string;
  context: () => Promise<ViewContext>;
  now?: () => number;
  /** false in tests: no timer; call sample() explicitly. */
  background?: boolean;
  intervalMs?: number;
};

/**
 * Samples processes every few seconds so the lineage of what agents start is known even after the agent exits
 * (a process outlives its parent → re-parented to launchd; only an earlier sample knows where it came from).
 * Persisted to agents.json so a NEX restart doesn't forget it.
 */
export class AgentMonitor {
  readonly tracker: AgentTracker;
  private readonly file: JsonFile<AgentSessionRecord[]>;
  private last: Snapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private savedAt = 0;

  constructor(private readonly opts: AgentMonitorOptions) {
    this.file = new JsonFile(join(opts.dataDir, 'agents.json'), () => [], raw => (Array.isArray(raw) ? raw as AgentSessionRecord[] : []));
    this.tracker = new AgentTracker(this.file.get());
  }
  private now() { return this.opts.now?.() ?? Date.now(); }

  start() {
    if (this.opts.background === false || this.timer) return;
    void this.sample().catch(() => {});
    this.timer = setInterval(() => void this.sample().catch(() => {}), this.opts.intervalMs ?? 10_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.save(true); }

  /** One sample: processes + listening ports + working directories of agents and re-parented processes. */
  sample(): Promise<Snapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const [processes, ports] = await Promise.all([this.opts.platform.listProcesses(), this.opts.platform.listeningPorts().catch(() => [])]);
      const now = this.now();
      const cwds = await this.opts.platform.processCwds(AgentTracker.cwdCandidates(processes, this.tracker.sessions.values(), now)).catch(() => new Map<number, string>());
      const snap: Snapshot = { now, processes, ports, cwds };
      this.tracker.observe(snap);
      this.last = snap;
      this.save(false);
      return snap;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private save(force: boolean) {
    if (!force && this.now() - this.savedAt < 30_000) return;
    this.savedAt = this.now();
    try { this.file.set(this.tracker.toJSON()); } catch { /* best effort */ }
  }

  /** Fresh enough view (≤ 4 s old). */
  async overview(): Promise<AgentOverview> {
    const snap = this.last && this.now() - this.last.now < 4000 ? this.last : await this.sample();
    return this.tracker.view(snap, await this.opts.context());
  }

  /** Re-checked targets for "Clean up this session" (always against a brand-new sample). */
  async targets(sessionId: string, pids: number[]) {
    const snap = await this.sample();
    return this.tracker.leftoverTargets(sessionId, pids, snap, await this.opts.context());
  }

  forceSave() { this.save(true); }
}
