/** Never surface "Something went wrong" — map to a reason the user can act on (PRD §26). */
export function explain(message: unknown, status: number, product = 'NEX') {
  const m = String(message ?? '');
  if (/no longer exists/i.test(m)) return 'Process no longer exists. It may have already closed.';
  if (m && status >= 400 && status < 500 && !/^Cannot|Internal/.test(m)) return m; // the API already explains itself
  if (/confirm/i.test(m)) return `Confirmation required before ${product} can act.`;
  return m || `Unsupported operation (HTTP ${status}).`;
}

/** JSON POST that turns network failures and HTTP errors into user-facing messages. */
export function createPost(product: string) {
  return async function post<T>(url: string, body: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      // Network-level failure: the local service is gone, not the action. Say so instead of "Failed to fetch".
      throw new Error(`Lost connection to ${product}’s local service. If it was started from an app that just closed, run npm run dev again.`);
    }
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(explain(json?.message, r.status, product));
    return json as T;
  };
}
