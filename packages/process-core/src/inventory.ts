import type { ProcessInfo } from '@nex/shared';
import type { ProcessSource } from '@nex/platform-core';

/**
 * One process scan shared by every consumer (MemNEX, DevNEX, Workbench).
 * Calls within `ttlMs` reuse the same result; concurrent calls share one in-flight `ps`.
 */
export class ProcessInventory implements ProcessSource {
  private cache: { at: number; promise: Promise<ProcessInfo[]> } | null = null;
  constructor(private readonly source: ProcessSource, private readonly ttlMs = 2000) {}

  listProcesses(): Promise<ProcessInfo[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.promise;
    const promise = this.source.listProcesses();
    this.cache = { at: Date.now(), promise };
    promise.catch(() => { this.cache = null; });
    return promise;
  }

  /** Force the next call to rescan (after an action changed the process list). */
  invalidate() { this.cache = null; }
}

/** Wrap a platform so its listProcesses() goes through a shared inventory. */
export function withSharedInventory<T extends ProcessSource>(platform: T, inventory: ProcessInventory): T {
  return new Proxy(platform, {
    get(target, prop, receiver) {
      if (prop === 'listProcesses') return () => inventory.listProcesses();
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
