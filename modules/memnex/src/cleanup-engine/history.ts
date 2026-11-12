type Event = { memoryBefore: number; memoryAfter: number; recovered: number; closed: string[]; durationMs: number };
export type CleanupEvent = Event & { id: number; createdAt: string };

/** Cleanup results for the current session only — in memory, capped, never written to disk. */
export class CleanupHistory {
  private events: CleanupEvent[] = [];
  constructor(private readonly max = 50) {}
  record(event: Event) {
    const id = (this.events[0]?.id ?? 0) + 1;
    this.events = [{ ...event, id, createdAt: new Date().toISOString() }, ...this.events].slice(0, this.max);
  }
  list() { return this.events; }
}
