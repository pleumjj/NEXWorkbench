import { exec } from '@nex/platform-core';
import type { DockerStorage } from '../storage-types';

/** Docker prints decimal sizes ("1.2GB", "512MB", "0B"). */
export function parseDockerSize(s: unknown): number {
  const m = String(s ?? '').trim().match(/^([\d.]+)\s*([kKMGTP]?B)?/);
  if (!m) return 0;
  const unit: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };
  return Math.round(Number(m[1]) * (unit[m[2] ?? 'B'] ?? 1));
}

const emptyBucket = () => ({ bytes: 0, reclaimableBytes: 0, count: 0 });

/** Parse `docker system df --format '{{json .}}'` (one JSON row per type). */
export function parseSystemDf(out: string): Pick<DockerStorage, 'images' | 'containers' | 'volumes' | 'buildCache'> {
  const r = { images: emptyBucket(), containers: emptyBucket(), volumes: emptyBucket(), buildCache: emptyBucket() };
  for (const line of out.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      const key = /image/i.test(j.Type) ? 'images' : /container/i.test(j.Type) ? 'containers' : /volume/i.test(j.Type) ? 'volumes' : /build/i.test(j.Type) ? 'buildCache' : null;
      if (!key) continue;
      r[key] = { bytes: parseDockerSize(j.Size), reclaimableBytes: parseDockerSize(j.Reclaimable), count: Number(j.TotalCount) || 0 };
    } catch { /* skip */ }
  }
  return r;
}

/**
 * Attribute images and volumes to Compose projects (an estimate by name: images "<project>-<service>",
 * volumes "<project>_<name>" or the com.docker.compose.project label). Input: `docker system df -v --format '{{json .}}'`.
 */
export function parseDfVerbose(out: string): Record<string, number> {
  const by: Record<string, number> = {};
  let j: any;
  try { j = JSON.parse(out.trim().split('\n')[0] || '{}'); } catch { return by; }
  const add = (k: string | null, n: number) => { if (k && n) by[k] = (by[k] ?? 0) + n; };
  for (const img of j.Images ?? []) {
    const repo = String(img.Repository ?? '');
    const m = repo.match(/^([a-z0-9][a-z0-9_-]*?)[-_][a-z0-9][\w.-]*$/);
    add(m ? m[1] : null, parseDockerSize(img.UniqueSize ?? img.Size));
  }
  for (const v of j.Volumes ?? []) {
    const label = String(v.Labels ?? '').match(/com\.docker\.compose\.project=([^,]+)/)?.[1] ?? null;
    const name = String(v.Name ?? '');
    add(label ?? (name.includes('_') && !/^[0-9a-f]{64}$/.test(name) ? name.slice(0, name.indexOf('_')) : null), parseDockerSize(v.Size));
  }
  return by;
}

/** Read-only Docker storage summary. Never prunes anything. Docker is optional. */
export async function dockerStorage(now = Date.now()): Promise<DockerStorage> {
  const base: DockerStorage = { available: false, detail: null, images: emptyBucket(), containers: emptyBucket(), volumes: emptyBucket(), buildCache: emptyBucket(), byComposeProject: {}, checkedAt: new Date(now).toISOString() };
  try {
    const { stdout } = await exec('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    const df = parseSystemDf(stdout);
    let byComposeProject: Record<string, number> = {};
    try {
      const v = await exec('docker', ['system', 'df', '-v', '--format', '{{json .}}'], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
      byComposeProject = parseDfVerbose(v.stdout);
    } catch { /* per-project attribution is optional */ }
    return { ...base, available: true, ...df, byComposeProject };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ...base, detail: 'Docker is not installed.' };
    if (e?.killed) return { ...base, detail: 'Docker did not respond in time.' };
    return { ...base, detail: /daemon|connect/i.test(String(e?.stderr)) ? 'Docker is installed but not running.' : 'Docker storage could not be read.' };
  }
}
