import type { ProcessInfo } from '@nex/shared';
import { classifyProcess, type ClassifyOptions, type GroupIdentity } from './classify';

export type ProcessGroup = GroupIdentity & {
  items: ProcessInfo[];
  pids: number[];
  /** The process that represents the app: its own executable (not a helper), else the oldest pid. */
  mainPid: number;
  memory: number;
  cpu: number;
};

/** Group processes into applications / tools, largest memory first. */
export function groupProcesses(processes: ProcessInfo[], opts: ClassifyOptions): ProcessGroup[] {
  const groups = new Map<string, { id: GroupIdentity; items: ProcessInfo[] }>();
  for (const p of processes) {
    const id = classifyProcess(p, opts);
    const g = groups.get(id.id) ?? { id, items: [] };
    g.items.push(p);
    groups.set(id.id, g);
  }
  return [...groups.values()].map(({ id, items }) => {
    const main = items.find(p => /\/Contents\/MacOS\//.test(p.command) && !/Helper|\.app\/.+\.app\//.test(p.command))
      ?? [...items].sort((a, b) => a.pid - b.pid)[0];
    return {
      ...id,
      items: [...items].sort((a, b) => b.memory - a.memory),
      pids: items.map(p => p.pid),
      mainPid: main.pid,
      memory: items.reduce((n, p) => n + p.memory, 0),
      cpu: items.reduce((n, p) => n + p.cpu, 0),
    };
  }).sort((a, b) => b.memory - a.memory);
}

/** App bundle paths present in a process list (for bundle-id lookups). */
export function appPaths(processes: ProcessInfo[], opts: ClassifyOptions) {
  const out = new Set<string>();
  for (const p of processes) { const r = classifyProcess(p, opts); if (r.kind === 'app' && r.path) out.add(r.path); }
  return [...out];
}
