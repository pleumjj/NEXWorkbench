import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * @nex/config — ports, bind host, data locations and a tiny JSON file store.
 * No database: every persisted value is a small JSON file next to the app that owns it.
 */

const envPort = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : fallback;
};

/**
 * One user-facing URL: http://localhost:3900 (the Workbench web app).
 * The API is internal (proxied by the web app under /api) and loopback-only.
 */
export const PORTS = {
  web: envPort('NEX_WEB_PORT', 3900),
  api: envPort('NEX_API_PORT', 3901),
} as const;

/** APIs control local processes: loopback only unless the user explicitly opts in. */
export const API_HOST = process.env.NEX_API_HOST || '127.0.0.1';

/** Allowed browser origins for an API (its own web app on localhost / 127.0.0.1). */
export const originsFor = (webPort: number) => [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];

/** Repository root, resolved from an app's working directory (apps/<name>). */
export const workspaceRoot = (cwd = process.cwd()) => resolve(cwd, '..', '..');

/** Per-product data directory next to the running API, e.g. apps/workbench-api/.memnex */
export const dataDir = (product: string, cwd = process.cwd()) => join(cwd, `.${product}`);

/** Workbench version from the repository's root package.json. */
export function workbenchVersion(root = workspaceRoot()): string {
  try { return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0'); } catch { return '0.0.0'; }
}

/** Workbench-level preferences (module-specific settings live with each module). */
export type WorkbenchPreferences = {
  /** Module ids hidden from the shell, Home and Attention. */
  disabledModules: string[];
  /** Polling cadence for live data in the UI. */
  refresh: 'normal' | 'relaxed';
  /** UI language: follow the operating system (default), or English / Thai. */
  language: 'system' | 'en' | 'th';
};
export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = { disabledModules: [], refresh: 'normal', language: 'system' };

export function normalizeWorkbenchPreferences(raw: unknown): WorkbenchPreferences {
  const r = (raw ?? {}) as Partial<WorkbenchPreferences>;
  return {
    disabledModules: Array.isArray(r.disabledModules) ? r.disabledModules.filter((x): x is string => typeof x === 'string') : [],
    refresh: r.refresh === 'relaxed' ? 'relaxed' : 'normal',
    language: r.language === 'en' || r.language === 'th' ? r.language : 'system',
  };
}

/**
 * A JSON file loaded once and written through on every change.
 * Deliberately not a database — values are small preferences/state (KBs).
 */
export class JsonFile<T extends object> {
  private value: T | null = null;
  constructor(private readonly file: string, private readonly defaults: () => T, private readonly normalize: (raw: unknown) => T = raw => raw as T) {}

  get(): T {
    if (this.value) return this.value;
    try { this.value = this.normalize(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch { this.value = this.defaults(); }
    return this.value;
  }

  set(next: T): T {
    this.value = next;
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(next, null, 2)); } catch { /* read-only FS: keep in memory */ }
    return next;
  }

  update(fn: (current: T) => T): T { return this.set(fn(this.get())); }
}

/**
 * Reject requests that did not come from this machine's own NEX web app (PRD §25).
 * - Host must be a loopback name/port we serve (blocks DNS-rebinding).
 * - If the browser sent an Origin, it must be one of ours (blocks cross-site requests / CSRF).
 * Requests without Origin (curl, same-origin GET) are allowed only when Host is loopback.
 */
export function checkLocalRequest(headers: { host?: string; origin?: string }, allowed: { origins: string[]; ports: number[] }): string | null {
  const host = (headers.host ?? '').toLowerCase();
  const m = host.match(/^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/);
  if (!m || (m[2] && !allowed.ports.includes(Number(m[2])))) return `Host "${headers.host ?? ''}" is not a local NEX address.`;
  if (headers.origin && !allowed.origins.includes(headers.origin)) return `Origin "${headers.origin}" is not allowed.`;
  return null;
}
