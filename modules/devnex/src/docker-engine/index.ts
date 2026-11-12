import { exec } from '@nex/platform-core';
import type { Container, DockerInfo } from '../types';

const label = (labels: string, key: string) => labels.split(',').map(s => s.split('=')).find(([k]) => k === key)?.slice(1).join('=') || null;

export function parseDockerPs(out: string): Container[] {
  return out.split('\n').filter(Boolean).flatMap(line => {
    try {
      const c = JSON.parse(line);
      const labels = String(c.Labels ?? '');
      return [{
        id: String(c.ID ?? ''), name: String(c.Names ?? ''), image: String(c.Image ?? ''),
        state: String(c.State ?? '').toLowerCase(), status: String(c.Status ?? ''), ports: String(c.Ports ?? ''),
        composeProject: label(labels, 'com.docker.compose.project'),
        workingDir: label(labels, 'com.docker.compose.project.working_dir'),
        projectId: null,
      }];
    } catch { return []; }
  });
}

/** Docker is optional: when it is missing or not running, DevNEX says so and keeps working. */
export async function dockerInfo(): Promise<DockerInfo> {
  try {
    const { stdout } = await exec('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
    return { available: true, detail: null, containers: parseDockerPs(stdout) };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { available: false, detail: 'Docker is not installed.', containers: [] };
    if (e?.killed) return { available: false, detail: 'Docker did not respond in time.', containers: [] };
    return { available: false, detail: /daemon|connect/i.test(String(e?.stderr)) ? 'Docker is installed but not running.' : 'Docker could not be queried.', containers: [] };
  }
}
