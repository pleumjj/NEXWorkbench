import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvReport, EnvRow } from '../types';

/** Minimal dotenv parser: KEY=VALUE, `export KEY=`, quotes, inline # comments on unquoted values. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = v.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
    if (quoted) v = quoted[2];
    else v = v.replace(/\s+#.*$/, '');
    out.set(m[1], v);
  }
  return out;
}

const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$|AUTH|SALT|SIGNING|DSN|COOKIE|SESSION)/i;
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

export const isSensitive = (key: string, value: string) => SENSITIVE_KEY.test(key) || URL_WITH_CREDENTIALS.test(value);

/**
 * Mask a value for display. Secrets never leave the API in clear text:
 * "sk-live-abcdef8Jx" → "sk-****8Jx"; short values → "****"; URLs keep scheme/host, hide credentials.
 */
export function maskValue(key: string, value: string): string {
  if (!value) return '';
  if (URL_WITH_CREDENTIALS.test(value)) return value.replace(/:\/\/([^/\s:@]+):([^/\s@]+)@/, '://****:****@');
  if (!isSensitive(key, value)) return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  if (value.length < 10) return '****';
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

const EXPECTED_FILES = ['.env.example', '.env.sample', '.env.template'];
const ACTUAL_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
const MAX_BYTES = 256 * 1024;

const readSmall = (file: string) => {
  try { if (!existsSync(file) || statSync(file).size > MAX_BYTES) return null; return readFileSync(file, 'utf8'); } catch { return null; }
};

/**
 * Compare what a project expects (.env.example) with what is configured (.env, .env.local…).
 * Values are read, masked and dropped — nothing is stored.
 */
export function inspectEnvironment(projectId: string, dir: string): EnvReport {
  const expectedFile = EXPECTED_FILES.find(f => existsSync(join(dir, f))) ?? null;
  const expected = expectedFile ? parseEnv(readSmall(join(dir, expectedFile)) ?? '') : new Map<string, string>();
  const files: string[] = [];
  const actual = new Map<string, { value: string; source: string }>();
  for (const f of ACTUAL_FILES) {
    const text = readSmall(join(dir, f));
    if (text == null) continue;
    files.push(f);
    for (const [k, v] of parseEnv(text)) actual.set(k, { value: v, source: f }); // later files override (.env.local wins)
  }
  const rows: EnvRow[] = [];
  for (const key of expected.keys()) {
    const a = actual.get(key);
    const status = !a ? 'missing' : a.value === '' ? 'empty' : 'configured';
    rows.push({ key, status, preview: a ? maskValue(key, a.value) : null, sensitive: a ? isSensitive(key, a.value) : SENSITIVE_KEY.test(key), source: a?.source ?? null });
  }
  for (const [key, a] of actual) {
    if (expected.has(key)) continue;
    rows.push({ key, status: 'extra', preview: maskValue(key, a.value), sensitive: isSensitive(key, a.value), source: a.source });
  }
  return {
    projectId, files, expectedFrom: expectedFile, rows,
    missing: rows.filter(r => r.status === 'missing' || r.status === 'empty').length,
    configured: rows.filter(r => r.status === 'configured').length,
  };
}
