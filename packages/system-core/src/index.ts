import * as os from 'node:os';
import type { HostInfo, MemoryReading } from '@nex/shared';
import type { MemorySource } from '@nex/platform-core';
import { CpuMeter } from './cpu';
import { SwapTrend } from './swap-trend';

export { CpuMeter } from './cpu';
export { SwapTrend } from './swap-trend';

export type SystemSample = {
  memory: MemoryReading;
  /** Bytes/sec currently being written to swap (null while measuring). */
  swapRate: number | null;
  cpu: { usage: number; cores: number; model: string };
  host: HostInfo;
  at: string;
};

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function hostInfo(): HostInfo {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    osName: OS_NAMES[process.platform] ?? process.platform,
    release: os.release(),
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model || 'Unknown',
    cores: cpus.length,
    totalMemory: os.totalmem(),
    uptime: os.uptime(),
  };
}

/**
 * One implementation of RAM / CPU / swap / host for every NEX product.
 * Share one instance per process: with `maxAgeMs`, callers within that window reuse the same
 * reading (one vm_stat / sysctl no matter how many modules ask).
 */
export class SystemMonitor {
  private readonly cpu = new CpuMeter();
  private readonly swap = new SwapTrend();
  private cache: { at: number; promise: Promise<SystemSample> } | null = null;

  constructor(private readonly source: MemorySource, private readonly maxAgeMs = 0) {}

  sample(): Promise<SystemSample> {
    if (this.maxAgeMs > 0 && this.cache && Date.now() - this.cache.at < this.maxAgeMs) return this.cache.promise;
    const promise = this.read();
    this.cache = { at: Date.now(), promise };
    promise.catch(() => { this.cache = null; });
    return promise;
  }

  private async read(): Promise<SystemSample> {
    const memory = await this.source.memory();
    this.swap.push(memory.swapOutBytes);
    const host = hostInfo();
    return {
      memory,
      swapRate: this.swap.rate(),
      cpu: { usage: this.cpu.sample(), cores: host.cores, model: host.cpuModel },
      host,
      at: new Date().toISOString(),
    };
  }
}
