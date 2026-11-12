import { sep } from 'node:path';
import type { PortInfo, ProcessInfo } from '@nex/shared';
import type { PortConflict, PortEntry, Project } from '../types';

const LOOPBACK = /^(127\.|::ffff:127\.|::1$|localhost$|\[::1\]$)/;
export const exposureOf = (address: string): PortEntry['exposure'] => (LOOPBACK.test(address) ? 'loopback' : 'network');

const within = (child: string | null | undefined, parent: string) => !!child && (child === parent || child.startsWith(parent + sep));

/**
 * Tie a process to a project: its working directory or command line lives inside the project,
 * or one of its ancestors does (npm → node → next-server).
 */
export function projectForPid(pid: number | null, ctx: { processes: Map<number, ProcessInfo>; cwds: Map<number, string>; projects: Project[] }): Project | null {
  for (let cur = pid, guard = 0; cur && cur > 1 && guard < 16; guard++) {
    const p = ctx.processes.get(cur);
    const cwd = ctx.cwds.get(cur) ?? null;
    // Longest path wins so a workspace package beats its parent folder.
    const hit = [...ctx.projects].sort((a, b) => b.path.length - a.path.length)
      .find(pr => within(cwd, pr.path) || (p && (p.command.includes(pr.path + sep) || p.command.endsWith(pr.path))));
    if (hit) return hit;
    cur = p?.ppid ?? null;
  }
  return null;
}

export function buildPortTable(ports: PortInfo[], ctx: { processes: Map<number, ProcessInfo>; cwds: Map<number, string>; projects: Project[] }): PortEntry[] {
  return ports.map(port => {
    const proc = port.pid ? ctx.processes.get(port.pid) ?? null : null;
    const project = projectForPid(port.pid, ctx);
    const service = project?.services.find(s => s.port === port.port) ?? null;
    return {
      port: port.port, address: port.address, exposure: exposureOf(port.address),
      pid: port.pid, processName: port.processName ?? proc?.name ?? null, command: proc?.command ?? null,
      cwd: port.pid ? ctx.cwds.get(port.pid) ?? null : null,
      projectId: project?.id ?? null, projectName: project?.name ?? null,
      serviceId: service?.id ?? null, serviceName: service?.name ?? null,
      unknown: !project,
    };
  });
}

/**
 * A conflict = a service declares a port that is currently held by a process that is not that service.
 * (A port held by the service's own project counts as "the service is running", not a conflict.)
 */
export function findConflicts(table: PortEntry[], projects: Project[]): PortConflict[] {
  const out: PortConflict[] = [];
  for (const project of projects) {
    for (const s of project.services) {
      if (!s.port) continue;
      const holder = table.find(e => e.port === s.port);
      if (!holder || holder.projectId === project.id) continue;
      out.push({
        port: s.port,
        usedBy: { pid: holder.pid, processName: holder.processName, projectName: holder.projectName, command: holder.command },
        requestedBy: { projectId: project.id, projectName: project.name, serviceId: s.id, serviceName: s.name },
      });
    }
  }
  return out;
}
