/** Tracks swap-out over time: swap that *exists* is history; swap that is *growing* is a live problem. */
export class SwapTrend {
  private samples: { t: number; swapOut: number }[] = [];
  constructor(private readonly windowMs = 60_000, private readonly minSpanMs = 15_000) {}

  push(swapOutBytes: number | null, now = Date.now()) {
    if (swapOutBytes == null) return;
    this.samples.push({ t: now, swapOut: swapOutBytes });
    this.samples = this.samples.filter(s => now - s.t <= this.windowMs);
  }

  /** Bytes/sec swapped out across the window, or null until there is enough data. */
  rate(): number | null {
    if (this.samples.length < 2) return null;
    const a = this.samples[0], b = this.samples[this.samples.length - 1];
    const dt = b.t - a.t;
    return dt < this.minSpanMs ? null : Math.max(0, (b.swapOut - a.swapOut) / (dt / 1000));
  }
}
