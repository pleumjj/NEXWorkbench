import * as os from 'node:os';

type Times = os.CpuInfo['times'];

/** Real CPU utilisation between calls (load average is a queue length, not a percentage). */
export class CpuMeter {
  private prev: Times[] = os.cpus().map(c => c.times);
  private last = 0;

  sample(now: Times[] = os.cpus().map(c => c.times)): number {
    let idle = 0, total = 0;
    now.forEach((t, i) => {
      const p = this.prev[i] ?? t;
      const d = { user: t.user - p.user, nice: t.nice - p.nice, sys: t.sys - p.sys, idle: t.idle - p.idle, irq: t.irq - p.irq };
      idle += d.idle; total += d.user + d.nice + d.sys + d.idle + d.irq;
    });
    if (total > 0) { this.last = Math.min(100, Math.max(0, (1 - idle / total) * 100)); this.prev = now; }
    return this.last;
  }
}
