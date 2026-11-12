import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { DevnexConfig, ProjectSignals } from '../types';

export const projectId = (path: string) => createHash('sha1').update(resolve(path)).digest('hex').slice(0, 10);

const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export function signalsOf(dir: string): ProjectSignals {
  const has = (f: string) => existsSync(join(dir, f));
  return {
    packageJson: has('package.json'), devnexConfig: has('devnex.config.json'), pnpmWorkspace: has('pnpm-workspace.yaml'),
    turbo: has('turbo.json'), compose: COMPOSE.find(has) ?? null, envExample: has('.env.example'), git: has('.git'),
  };
}

/** A directory is a project if it carries one of the discovery signals. */
export const isProjectDir = (dir: string) => {
  const s = signalsOf(dir);
  return s.packageJson || s.devnexConfig || !!s.compose;
};

export function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}

export function loadConfig(dir: string): DevnexConfig | null {
  const raw = readJson<DevnexConfig>(join(dir, 'devnex.config.json'));
  if (!raw || typeof raw !== 'object') return null;
  const services = Array.isArray(raw.services)
    ? raw.services.filter(s => s && typeof s.name === 'string').map(s => ({
        name: s.name, command: typeof s.command === 'string' ? s.command : undefined,
        port: Number.isInteger(s.port) && s.port! > 0 && s.port! < 65536 ? s.port : undefined, type: s.type, healthUrl: s.healthUrl,
      }))
    : undefined;
  return { name: typeof raw.name === 'string' ? raw.name : undefined, services };
}

export function projectName(dir: string): string {
  return loadConfig(dir)?.name ?? readJson<{ name?: string }>(join(dir, 'package.json'))?.name ?? basename(dir);
}

export function packageManagerOf(dir: string): 'npm' | 'pnpm' | 'yarn' | null {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'package.json'))) return 'npm';
  return null;
}

/**
 * Walk up from a process's working directory to the outermost project root below $HOME
 * (so a workspace package resolves to its monorepo root). Never climbs above $HOME.
 */
export function findProjectRoot(start: string, home = homedir()): string | null {
  let dir = resolve(start), found: string | null = null;
  if (!dir.startsWith(home + sep) || dir === home) return null;
  // Tool/app internals (~/.vscode/extensions, ~/.npm, ~/Library…) are not the user's projects.
  const rel = dir.slice(home.length + 1).split(sep);
  if (rel.some(seg => seg.startsWith('.')) || rel[0] === 'Library' || rel.includes('node_modules')) return null;
  for (let i = 0; i < 12 && dir.startsWith(home + sep); i++) {
    if (isProjectDir(dir)) found = dir;
    // A git root or a devnex config is a definite boundary.
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'devnex.config.json'))) return dir;
    dir = dirname(dir);
  }
  return found;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'Library', '.cache', 'vendor']);

/** Projects up to `depth` levels below a root folder the user registered. Bounded to stay fast. */
export function scanRoot(root: string, depth = 2, limit = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (out.length >= limit) return;
    if (isProjectDir(dir)) { out.push(dir); return; }
    if (d === 0) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.') || SKIP.has(e)) continue;
      const p = join(dir, e);
      try { if (statSync(p).isDirectory()) walk(p, d - 1); } catch {}
    }
  };
  walk(resolve(root), depth);
  return out;
}
