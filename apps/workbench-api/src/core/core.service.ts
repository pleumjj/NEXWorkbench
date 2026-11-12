import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { ActivityEvent, ForegroundWindow } from '@nex/shared';
import { DEFAULT_WORKBENCH_PREFERENCES, JsonFile, dataDir, normalizeWorkbenchPreferences, type WorkbenchPreferences } from '@nex/config';
import { createPlatform, type PlatformAdapter } from '@nex/platform-core';
import { ProcessInventory, withSharedInventory } from '@nex/process-core';
import { SystemMonitor } from '@nex/system-core';
import { EventBus, closeAllStreams } from '@nex/telemetry-core';
import { RingBuffer } from '@nex/logger';

/**
 * MemNEX (idle-app learning) and WorkNEX (work contexts) both need the front app every few seconds:
 * one OS read serves both. A foregroundWindow reading also answers activeApp() while it is fresh.
 */
function withSharedForeground<T extends PlatformAdapter>(platform: T, ttlMs = 4000): T {
  let win: { at: number; title: boolean; value: Promise<ForegroundWindow> } | null = null;
  const foregroundWindow = (opts: { title: boolean }) => {
    if (win && Date.now() - win.at < ttlMs && (win.title || !opts.title)) return win.value;
    const value = platform.foregroundWindow(opts);
    win = { at: Date.now(), title: opts.title, value };
    value.catch(() => { win = null; });
    return value;
  };
  const activeApp = async () => {
    if (win && Date.now() - win.at < ttlMs) { const w = await win.value.catch(() => null); if (w) return { key: w.key, pid: w.pid, idleMs: w.idleMs }; }
    return platform.activeApp();
  };
  return new Proxy(platform, {
    get(target, prop, receiver) {
      if (prop === 'foregroundWindow') return foregroundWindow;
      if (prop === 'activeApp') return activeApp;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const ACTIVITY_TITLES: Record<string, (d: any) => string> = {
  'memnex.cleanup.completed': d => `Smart Cleanup closed ${d.closed?.length ?? 0} app${d.closed?.length === 1 ? '' : 's'}`,
  'memnex.memory.high': d => `Memory pressure ${String(d.state ?? '').toLowerCase()}`,
  'memnex.app.closed': d => `${d.app} closed`,
  'devnex.service.started': d => `Started ${d.name ?? d.serviceId}`,
  'devnex.service.stopped': d => `Stopped ${d.name ?? d.serviceId}`,
  'devnex.service.failed': d => `${d.name ?? d.serviceId} failed${d.exitCode != null ? ` (exit ${d.exitCode})` : ''}`,
  'devnex.port.conflict': d => `Port ${d.port} conflict for ${d.requestedBy?.projectName ?? 'a project'}`,
  'devnex.process.stopped': d => `Stopped ${d.name ?? 'process'} (PID ${d.pid})`,
  // WorkNEX: derived events only (never individual app switches).
  'worknex.context.started': d => (d.type === 'development' || d.type === 'document' ? `Started ${d.title} context` : ''),
  'worknex.context.saved': d => `Saved ${d.title} context`,
  'worknex.context.resumed': d => `Resumed ${d.title}`,
  'worknex.collection.paused': () => 'WorkNEX paused',
  'worknex.collection.resumed': () => 'WorkNEX resumed',
  'filenex.location.added': d => `FileNEX now indexes “${d.label}”`,
  'filenex.location.removed': d => `FileNEX stopped indexing “${d.label}”${d.deletedIndex ? ' (index deleted)' : ''}`,
  'filenex.location.scanned': d => (d.changed || d.removed ? `FileNEX indexed “${d.label}” (${d.files} files)` : ''),
  'filenex.indexing.paused': () => 'FileNEX indexing paused',
  'filenex.indexing.resumed': () => 'FileNEX indexing resumed',
  'worknex.app.tracked': d => `WorkNEX now tracks ${d.name}`,
  'worknex.app.untracked': d => `WorkNEX stopped tracking ${d.name}${d.deletedHistory ? ' (history deleted)' : ''}`,
};
const SOURCE: Record<string, string> = { memnex: 'MemNEX', devnex: 'DevNEX', worknex: 'WorkNEX', filenex: 'FileNEX' };

/**
 * Shared foundation for every module in this process:
 * one OS adapter, one process inventory (one `ps` per 2 s no matter how many modules ask),
 * one system monitor (one memory/CPU read per second), one event bus, and a session-only activity log.
 */
@Injectable()
export class CoreService implements BeforeApplicationShutdown {
  readonly inventory: ProcessInventory;
  readonly platform;
  readonly system: SystemMonitor;
  readonly bus = new EventBus();
  readonly activity = new RingBuffer<ActivityEvent>(100);
  readonly preferences = new JsonFile<WorkbenchPreferences>(join(dataDir('nex'), 'workbench.json'), () => ({ ...DEFAULT_WORKBENCH_PREFERENCES }), normalizeWorkbenchPreferences);
  readonly startedAt = new Date().toISOString();
  /** Open SSE connections — background tickers only work while someone is watching. */
  listeners = 0;
  private seq = 0;

  /** Live SSE streams never end on their own; close them so a restart (node --watch, Ctrl+C) isn't blocked. */
  beforeApplicationShutdown() { closeAllStreams(); }

  constructor() {
    const raw = createPlatform();
    this.inventory = new ProcessInventory(raw, 2000);
    this.platform = withSharedForeground(withSharedInventory(raw, this.inventory));
    this.system = new SystemMonitor(this.platform, 1000);
    this.bus.subscribe(e => {
      const title = ACTIVITY_TITLES[e.type]?.((e.data ?? {}) as any);
      if (!title) return;
      this.activity.push({ id: `a${++this.seq}`, sourceModule: SOURCE[e.type.split('.')[0]] ?? 'NEX Workbench', type: e.type, title, timestamp: e.at });
    });
  }
}
