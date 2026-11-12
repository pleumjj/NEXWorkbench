/**
 * @nex/logger — minimal leveled console logger and a bounded ring buffer.
 * No transports, no external telemetry: logs stay on this machine.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.NEX_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

export type Logger = Record<Level, (message: string, meta?: unknown) => void>;

export function createLogger(scope: string): Logger {
  const write = (level: Level) => (message: string, meta?: unknown) => {
    if (ORDER[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    meta === undefined ? out(line) : out(line, meta);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

/** Fixed-capacity FIFO: oldest entries are dropped, memory never grows past `capacity`. */
export class RingBuffer<T> {
  private items: T[] = [];
  private dropped = 0;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('RingBuffer capacity must be a positive integer');
  }
  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.capacity) { this.items.shift(); this.dropped++; }
  }
  toArray(): T[] { return [...this.items]; }
  get size() { return this.items.length; }
  /** How many entries have been discarded because the buffer was full. */
  get droppedCount() { return this.dropped; }
  clear() { this.items = []; }
}
