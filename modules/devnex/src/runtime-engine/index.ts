import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from '@nex/platform-core';
import type { RuntimeCheck, RuntimeTool } from '../types';

/** Parse "v22.12.0" / "10.4.1" → [22, 12, 0]. */
export const parseVersion = (v: string | null | undefined): [number, number, number] | null => {
  const m = String(v ?? '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
};
const cmp = (a: number[], b: number[]) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/**
 * Small semver range check covering what projects actually write in engines/.nvmrc:
 * "22", "22.x", "22.1.x", ">=20", ">=18 <21", "^22.1.0", "~22.1", "20 || 22", "lts/*" (unknown).
 * Returns null when the range can't be interpreted (shown as "unknown", never as a mismatch).
 */
export function satisfies(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  const alternatives = range.split('||').map(s => s.trim()).filter(Boolean);
  if (!alternatives.length) return null;
  let understood = false;
  for (const alt of alternatives) {
    const parts = alt.split(/\s+/).filter(Boolean);
    let ok = true, any = false;
    for (const part of parts) {
      const m = part.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
      if (!m) { ok = false; continue; }
      any = true;
      const [, op = '', a, b, c] = m;
      if (a === 'x' || a === '*') continue;
      const nums = [Number(a), b && b !== 'x' && b !== '*' ? Number(b) : null, c && c !== 'x' && c !== '*' ? Number(c) : null];
      const base = [nums[0]!, nums[1] ?? 0, nums[2] ?? 0];
      const d = cmp(v, base);
      if (op === '>=') ok &&= d >= 0;
      else if (op === '>') ok &&= d > 0;
      else if (op === '<=') ok &&= d <= 0;
      else if (op === '<') ok &&= d < 0;
      else if (op === '^') ok &&= d >= 0 && v[0] === base[0];
      else if (op === '~') ok &&= d >= 0 && v[0] === base[0] && (nums[1] == null || v[1] === base[1]);
      else ok &&= v[0] === base[0] && (nums[1] == null || v[1] === nums[1]) && (nums[2] == null || v[2] === nums[2]);
    }
    if (any) understood = true;
    if (any && ok) return true;
  }
  return understood ? false : null;
}

const run = (cmd: string, args: string[]) =>
  exec(cmd, args, { timeout: 4000, shell: process.platform === 'win32' }).then(r => r.stdout.trim().split('\n')[0] || null).catch(() => null);

const KNOWN_TOOLS = new Set(['node', 'npm', 'pnpm', 'yarn']);
let cache: { at: number; tools: RuntimeTool[] } | null = null;

/** Installed tool versions (cached 5 min — spawning 6 processes every poll would be wasteful). */
export async function detectRuntimes(force = false): Promise<RuntimeTool[]> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.tools;
  const [npm, pnpm, yarn, docker, git] = await Promise.all([
    run('npm', ['-v']), run('pnpm', ['-v']), run('yarn', ['-v']),
    run('docker', ['--version']).then(v => v?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null),
    run('git', ['--version']).then(v => v?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null),
  ]);
  const tools: RuntimeTool[] = [
    { name: 'node', version: process.versions.node }, { name: 'npm', version: npm }, { name: 'pnpm', version: pnpm },
    { name: 'yarn', version: yarn }, { name: 'docker', version: docker }, { name: 'git', version: git },
  ];
  cache = { at: Date.now(), tools };
  return tools;
}

/** What a project asks for: engines, .nvmrc / .node-version, packageManager. */
export function projectRequirements(dir: string): { tool: string; required: string; source: string }[] {
  const out: { tool: string; required: string; source: string }[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // Only runtimes DevNEX can check; other engines (vscode, electron…) are not local tools.
    for (const [tool, range] of Object.entries(pkg.engines ?? {})) if (typeof range === 'string' && KNOWN_TOOLS.has(tool)) out.push({ tool, required: range, source: 'package.json engines' });
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.match(/^(npm|pnpm|yarn)@([\d.]+)/) : null;
    if (pm && !out.some(r => r.tool === pm[1])) out.push({ tool: pm[1], required: pm[2], source: 'package.json packageManager' });
  } catch {}
  for (const f of ['.nvmrc', '.node-version']) {
    if (out.some(r => r.tool === 'node')) break;
    const p = join(dir, f);
    if (existsSync(p)) { const v = readFileSync(p, 'utf8').trim(); if (v) out.push({ tool: 'node', required: v.replace(/^v/, ''), source: f }); }
  }
  return out;
}

export function checkRuntimes(dir: string, tools: RuntimeTool[]): RuntimeCheck[] {
  return projectRequirements(dir).map(req => {
    const installed = tools.find(t => t.name === req.tool)?.version ?? null;
    if (!installed) return { ...req, installed: null, status: 'missing' as const };
    // packageManager pins an exact version; treat it as "same major" to avoid noise.
    const range = req.source.includes('packageManager') ? `^${req.required}` : req.required;
    const ok = satisfies(installed, range);
    return { ...req, installed, status: ok == null ? 'unknown' as const : ok ? 'ok' as const : 'mismatch' as const };
  });
}
