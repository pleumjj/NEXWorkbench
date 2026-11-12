/** Reopen is only offered for apps MemNEX itself closed, for this long. */
export const REOPEN_WINDOW_MS = 60 * 60_000;
export type Closed = { id: string; name: string; bundleId: string | null; path: string | null; closedAt: number };

/** Apps MemNEX closed recently. The API can only relaunch entries from here — never arbitrary programs. */
export class ReopenRegistry {
  private readonly closed = new Map<string, Closed>();
  remember(app: { id: string; name: string; kind: string; bundleId: string | null; path: string | null }, now = Date.now()) {
    if (app.kind === 'app') this.closed.set(app.id, { id: app.id, name: app.name, bundleId: app.bundleId, path: app.path, closedAt: now });
  }
  /** Drop expired entries and apps that are running again. */
  prune(runningIds: Set<string>, now = Date.now()) {
    for (const [id, c] of this.closed) if (now - c.closedAt > REOPEN_WINDOW_MS || runningIds.has(id)) this.closed.delete(id);
  }
  take(id: string, now = Date.now()): Closed | null {
    const c = this.closed.get(id);
    if (!c || now - c.closedAt > REOPEN_WINDOW_MS) return null;
    this.closed.delete(id);
    return c;
  }
  list() { return [...this.closed.values()].map(c => ({ id: c.id, name: c.name, closedAt: new Date(c.closedAt).toISOString() })); }
}
