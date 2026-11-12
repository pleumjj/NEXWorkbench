import { join } from 'node:path';
import type { PlatformAdapter } from '@nex/platform-core';
import { ProcessController, ancestorsOf, appPaths, describeProcess, groupProcesses, waitUntilGone, type ClassifyOptions } from '@nex/process-core';
import { SystemMonitor } from '@nex/system-core';
import type { ActionOutcome, AppSummary, CleanupPreview, CleanupResult, ProcessItem, Snapshot } from './types';
import { MemnexError, fromActionError } from './errors';
import { assessHealth } from './memory-engine/health';
import { MemoryGrowth } from './memory-engine/growth';
import { ActivityTracker } from './recommendation-engine/activity';
import { recommend } from './recommendation-engine/recommend';
import { diagnose } from './recommendation-engine/diagnosis';
import { PreferenceStore } from './protection-engine/preferences';
import { assertControllable, protectionFor } from './protection-engine/protection';
import { CleanupHistory } from './cleanup-engine/history';
import { ReopenRegistry } from './cleanup-engine/reopen';
import { buildPreview, cleanable, summarizeCleanup } from './cleanup-engine/cleanup';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type MemnexEngineOptions = {
  platform: PlatformAdapter;
  /** Directory for MemNEX's small JSON files (preferences, activity). */
  dataDir: string;
  /** NEX Workbench root — processes running from here are "self". */
  workspaceRoot: string;
  selfPid?: number;
  /** Shared system monitor (one RAM/CPU reader for the whole Workbench). Created if omitted. */
  system?: SystemMonitor;
};

/**
 * MemNEX business logic behind one facade. The API layer only routes HTTP to these methods
 * and maps MemnexError codes to status codes.
 */
export class MemnexEngine {
  private readonly system: SystemMonitor;
  private readonly control: ProcessController;
  private readonly growth = new MemoryGrowth();
  private readonly activity: ActivityTracker;
  readonly preferences: PreferenceStore;
  readonly history = new CleanupHistory();
  private readonly reopenable = new ReopenRegistry();
  private readonly classify: ClassifyOptions;
  private readonly selfPid: number;

  constructor(private readonly opts: MemnexEngineOptions) {
    this.selfPid = opts.selfPid ?? process.pid;
    this.system = opts.system ?? new SystemMonitor(opts.platform);
    this.control = new ProcessController(opts.platform);
    this.activity = new ActivityTracker(join(opts.dataDir, 'activity.json'));
    this.preferences = new PreferenceStore(join(opts.dataDir, 'settings.json'));
    this.classify = {
      selfRoot: opts.workspaceRoot, selfPid: this.selfPid, selfName: 'NEX Workbench',
      systemName: opts.platform.id === 'win32' ? 'Windows system services' : 'macOS system services',
    };
  }

  /** Begin foreground sampling (PowerShell is costlier to spawn, so Windows samples less often). */
  start() { this.activity.start(this.opts.platform, this.opts.platform.id === 'win32' ? 10_000 : 5_000); }
  stop() { this.activity.stop(); }

  async snapshot(): Promise<Snapshot> {
    const [sample, raw] = await Promise.all([this.system.sample(), this.opts.platform.listProcesses()]);
    const { memory: mem } = sample;
    const health = assessHealth(mem, sample.swapRate);

    const bundleIds = new Map<string, string | null>();
    await Promise.all(appPaths(raw, this.classify).map(async p => bundleIds.set(p, await this.opts.platform.bundleId(p))));
    const hostPids = ancestorsOf(raw, this.selfPid);
    const groups = groupProcesses(raw, this.classify);
    const apps = recommend(groups, {
      health: health.state, bundleIds,
      protectionOf: g => protectionFor(g, { hostPids, isProtected: n => this.preferences.isProtected(n) }),
      activityKey: a => this.opts.platform.activityKey(a),
      activity: (key, pids) => this.activity.activityOf(key, pids),
      growth: id => this.growth.growthOf(id),
      isMuted: n => this.preferences.isMuted(n),
    });
    this.growth.record(groups.map(g => ({ id: g.id, mainPid: g.mainPid, memory: g.memory, procs: g.items })));

    const appOf = new Map<number, AppSummary>();
    for (const a of apps) for (const pid of a.pids) appOf.set(pid, a);
    const processes: ProcessItem[] = raw
      .map(p => {
        const a = appOf.get(p.pid)!;
        return { ...p, app: a.name, protected: a.status === 'Protected' || a.status === 'System Critical', status: a.status, reason: a.reasons[0], about: describeProcess(p.name, p.command) };
      })
      .sort((a, b) => b.memory - a.memory);

    this.reopenable.prune(new Set(apps.map(a => a.id)));
    const watchingMinutes = Math.round(this.activity.watchingMinutes());
    const insight = diagnose({
      state: health.state, pressure: mem.pressure, swapRising: health.swapRising, swapRate: sample.swapRate,
      compressed: mem.compressed, total: mem.total, cpuUsage: sample.cpu.usage, cores: sample.cpu.cores, apps, processes, watchingMinutes,
    });
    return {
      memory: { total: mem.total, used: mem.used, available: mem.available, percent: (mem.used / mem.total) * 100, compressed: mem.compressed, cached: mem.cached, state: health.state, rationale: health.rationale, pressure: mem.pressure },
      swap: { ...mem.swap, percent: mem.swap.total ? (mem.swap.used / mem.swap.total) * 100 : 0, rising: health.swapRising },
      signals: health.signals,
      cpu: sample.cpu,
      system: { uptime: sample.host.uptime },
      processes,
      apps,
      recommendations: apps.filter(a => a.recommended).slice(0, 6).map(a => ({ pid: a.mainPid, name: a.name, memory: a.memory, reason: a.reasons.join(' · ') })),
      recentlyClosed: this.reopenable.list(),
      watchingMinutes,
      insight,
      platform: this.opts.platform.id,
      updatedAt: sample.at,
    };
  }

  async cleanupPreview(): Promise<CleanupPreview> { return buildPreview(await this.snapshot()); }

  async act(pid: number, action: 'quit' | 'kill' | 'restart'): Promise<ActionOutcome> {
    if (!Number.isInteger(pid) || pid < 1) throw new MemnexError('bad_request', 'Invalid process ID.');
    if (!['quit', 'kill', 'restart'].includes(action)) throw new MemnexError('bad_request', 'Unsupported operation.');
    const { apps } = await this.snapshot();
    const app = assertControllable(apps.find(a => a.pids.includes(pid)));
    // GUI apps are handled as a whole; command-line processes only ever one pid at a time.
    const targets = app.kind === 'app' ? app.pids : [pid];
    try {
      if (action === 'restart') {
        if (app.kind !== 'app') throw new MemnexError('bad_request', 'Restart is only available for applications.');
        const { stillRunning } = await this.control.quitApp(app, 8000);
        if (stillRunning) return { ok: true, app: app.name, stillRunning: true, reopened: false, detail: 'Application did not close, so it was not restarted. It may be waiting for you to save.' };
        await sleep(400);
        await this.opts.platform.launch(app);
        return { ok: true, app: app.name, stillRunning: false, reopened: true };
      }
      if (action === 'quit') {
        const { stillRunning } = app.kind === 'app' ? await this.control.quitApp(app) : await this.control.stopProcess(pid);
        if (!stillRunning) this.reopenable.remember(app);
        return { ok: true, app: app.name, stillRunning, detail: stillRunning ? 'Application did not close. It may be waiting for you to save, or it refused a normal quit.' : undefined };
      }
      const { stillRunning } = await this.control.forceKill(targets);
      if (!stillRunning) this.reopenable.remember(app);
      return { ok: true, app: app.name, stillRunning };
    } catch (e) { throw fromActionError(e); }
  }

  /** Only apps MemNEX closed in the last hour — the API can't be used to launch arbitrary programs. */
  async reopen(appId: string) {
    const c = this.reopenable.take(appId);
    if (!c) throw new MemnexError('not_found', 'MemNEX can only reopen apps it closed in the last hour.');
    try { await this.opts.platform.launch(c); } catch (e) { throw fromActionError(e); }
    return { ok: true, app: c.name };
  }

  async executeCleanup(appIds: string[], shownIds: string[] = []): Promise<CleanupResult> {
    const started = Date.now();
    const before = await this.snapshot();
    const selected = before.apps.filter(a => appIds.includes(a.id) && cleanable(a));
    if (!selected.length) throw new MemnexError('bad_request', 'None of the selected applications can be closed.');

    // Graceful only — cleanup never force-closes.
    const results = await Promise.allSettled(selected.map(a => this.opts.platform.quitApp(a)));
    await waitUntilGone(selected.map(a => a.mainPid), 6000);
    await sleep(500); // let the OS account for the freed pages
    const after = await this.snapshot();
    const { closed, stillRunning, failed, released } = summarizeCleanup(selected, results, after.processes);
    closed.forEach(a => this.reopenable.remember(a));

    // Learn: suggestions the user saw but left unchecked count toward "you usually keep it open".
    const shown = before.apps.filter(a => shownIds.includes(a.id) && (a.recommended || a.suggested));
    this.preferences.learn(shown.filter(a => !appIds.includes(a.id)).map(a => a.name), closed.map(c => c.name));

    const durationMs = Date.now() - started;
    this.history.record({ memoryBefore: before.memory.used, memoryAfter: after.memory.used, recovered: released, closed: closed.map(c => c.name), durationMs });
    return { before: before.memory.used, after: after.memory.used, recovered: released, closed: closed.map(c => ({ id: c.id, name: c.name })), stillRunning, failed, durationMs };
  }

  async commandOf(pid: number) {
    if (!Number.isInteger(pid) || pid < 1) return null;
    return (await this.opts.platform.listProcesses()).find(p => p.pid === pid)?.command ?? null;
  }
}
