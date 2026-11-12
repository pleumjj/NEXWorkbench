import { join } from 'node:path';
import type { ServiceDefinition, ServiceType } from '../types';
import { loadConfig, packageManagerOf, readJson, signalsOf } from './discovery';

const typeFromName = (name: string, command = ''): ServiceType => {
  const s = `${name} ${command}`.toLowerCase();
  if (/postgres|mysql|mariadb|mongo|database|\bdb\b|sqlite/.test(s)) return 'database';
  if (/redis|memcache|cache/.test(s)) return 'cache';
  if (/queue|rabbit|kafka|nats|bull/.test(s)) return 'queue';
  if (/worker|job|cron/.test(s)) return 'worker';
  if (/web|front|ui|next|vite|client|app\b/.test(s)) return 'frontend';
  if (/api|back|server|nest|express|service/.test(s)) return 'backend';
  return 'app';
};

/** Port declared in a script, e.g. "next dev -p 3100", "--port 5173", "PORT=4000 node …". */
export const portFromScript = (script: string): number | null => {
  const m = script.match(/(?:-p|--port)[ =](\d{2,5})\b/) ?? script.match(/\bPORT=(\d{2,5})\b/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

const DEV_SCRIPT = /^(dev|start|serve|develop|watch)(:.+)?$/;

/**
 * Services of a project, from (in order of authority): devnex.config.json → package.json dev/start scripts → compose services.
 * Commands always come from the project's own files.
 */
export function serviceDefinitions(dir: string, idPrefix: string): ServiceDefinition[] {
  const config = loadConfig(dir);
  const id = (name: string) => `${idPrefix}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (config?.services?.length) {
    return config.services.map(s => ({ id: id(s.name), name: s.name, type: s.type ?? typeFromName(s.name, s.command), command: s.command ?? null, port: s.port ?? null, source: 'devnex.config.json' as const }));
  }
  const out: ServiceDefinition[] = [];
  const pkg = readJson<{ scripts?: Record<string, string> }>(join(dir, 'package.json'));
  const pm = packageManagerOf(dir) ?? 'npm';
  const scripts = Object.entries(pkg?.scripts ?? {}).filter(([k, v]) => DEV_SCRIPT.test(k) && typeof v === 'string');
  // Prefer the dev:* family when present; plain "start" is usually the production twin of "dev".
  const devFamily = scripts.filter(([k]) => k === 'dev' || k.startsWith('dev:'));
  for (const [name, script] of devFamily.length ? devFamily : scripts.slice(0, 3)) {
    out.push({ id: id(name), name, type: typeFromName(name, script), command: pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`, port: portFromScript(script), source: 'package.json' });
  }
  const compose = signalsOf(dir).compose;
  if (compose) out.push({ id: id(`compose`), name: 'docker compose', type: 'container', command: null, port: null, source: 'docker-compose' });
  return out;
}
