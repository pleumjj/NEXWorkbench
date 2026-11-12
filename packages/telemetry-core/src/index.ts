import { EventEmitter } from 'node:events';
import type { ServerResponse, IncomingMessage } from 'node:http';

/**
 * @nex/telemetry-core — in-process event bus + Server-Sent Events.
 * "Telemetry" here means live local data for the local UI. Nothing is sent to any external server.
 */
export type NexEvent<T = unknown> = { type: string; at: string; data: T };

export class EventBus {
  private readonly emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(100); }

  publish<T>(type: string, data: T) {
    const event: NexEvent<T> = { type, at: new Date().toISOString(), data };
    this.emitter.emit('event', event);
  }

  subscribe(fn: (e: NexEvent) => void, filter?: (type: string) => boolean): () => void {
    const handler = (e: NexEvent) => { if (!filter || filter(e.type)) fn(e); };
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}

/** Topic filter: "system.*" matches "system.memory.updated". */
export const topicFilter = (patterns: string[]) => (type: string) =>
  !patterns.length || patterns.some(p => (p.endsWith('*') ? type.startsWith(p.slice(0, -1)) : type === p));

/** Open SSE responses, so shutdown can end them (they never close on their own and would block a graceful exit). */
const openStreams = new Set<ServerResponse>();

/** End every open SSE stream (call on shutdown). Browsers' EventSource reconnects to the next server by itself. */
export function closeAllStreams() {
  for (const res of openStreams) { try { res.end(); } catch { /* already gone */ } }
  openStreams.clear();
}

/**
 * Stream bus events to an HTTP response as SSE. Sends a comment heartbeat so proxies keep the
 * connection open, and unsubscribes when the client disconnects.
 */
export function streamSse(req: IncomingMessage, res: ServerResponse, bus: EventBus, patterns: string[] = [], initial: NexEvent[] = []) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: NexEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  initial.forEach(send);
  openStreams.add(res);
  const off = bus.subscribe(send, topicFilter(patterns));
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  beat.unref();
  req.on('close', () => { clearInterval(beat); off(); openStreams.delete(res); });
}

/** Run `fn` every `ms` without overlapping runs; returns a stop function. */
export function every(ms: number, fn: () => Promise<void> | void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch { /* the next tick retries */ } finally { running = false; }
  };
  const t = setInterval(tick, ms);
  t.unref();
  void tick();
  return () => clearInterval(t);
}
