import type { ProcessInfo } from '@nex/shared';
import type { Container, EnvReport, HealthIssue, PortConflict, PortEntry, Project, RuntimeCheck } from '../types';

const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const HIGH_MEMORY = 1.5 * 1024 ** 3;
const DEV_RUNTIME = /^(node|bun|deno|python\d?(\.\d+)?|ruby|java|php|go|next-server|vite|nest)/i;

export type HealthInput = {
  projects: Project[];
  conflicts: PortConflict[];
  ports: PortEntry[];
  processes: Map<number, ProcessInfo>;
  env: Map<string, EnvReport>;
  runtime: Map<string, RuntimeCheck[]>;
  containers: Container[];
};

/**
 * Deterministic checks. Each issue explains what, why and what to do — and nothing is ever fixed automatically.
 */
export function evaluateHealth(input: HealthInput): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const push = (i: HealthIssue) => issues.push(i);

  for (const c of input.conflicts) {
    push({
      id: `conflict:${c.port}:${c.requestedBy.serviceId}`, severity: 'critical', projectId: c.requestedBy.projectId, serviceId: c.requestedBy.serviceId, port: c.port, pid: c.usedBy.pid ?? undefined,
      title: `Port ${c.port} conflict`,
      description: `${c.requestedBy.projectName} › ${c.requestedBy.serviceName} needs port ${c.port}, but it is held by ${c.usedBy.processName ?? 'another process'}${c.usedBy.pid ? ` (PID ${c.usedBy.pid})` : ''}${c.usedBy.projectName ? ` from ${c.usedBy.projectName}` : ''}.`,
      reason: 'Only one process can listen on a port. The service will fail to start or another app is answering in its place.',
      recommendedAction: 'Stop the process holding the port if you no longer need it, or change the service’s port.',
    });
  }

  for (const project of input.projects) {
    for (const s of project.services) {
      if (s.status === 'FAILED') push({
        id: `crash:${s.id}`, severity: 'critical', projectId: project.id, serviceId: s.id,
        title: `${s.name} crashed`, description: `${project.name} › ${s.name} exited${s.exitCode != null ? ` with code ${s.exitCode}` : ''}.`,
        reason: 'The process stopped without being asked to. The last log lines usually show why.',
        recommendedAction: 'Open the service logs, fix the error, then start it again.',
      });
      if (s.status === 'WARNING' && s.detail) push({
        id: `warn:${s.id}`, severity: 'warning', projectId: project.id, serviceId: s.id,
        title: `${s.name} is not answering`, description: s.detail, reason: 'The process is running but its port never opened.',
        recommendedAction: 'Check the logs for build errors or a different port.',
      });
      if (s.memoryBytes != null && s.memoryBytes >= HIGH_MEMORY) push({
        id: `mem:${s.id}`, severity: 'warning', projectId: project.id, serviceId: s.id, pid: s.pid ?? undefined,
        title: `${s.name} uses ${fmt(s.memoryBytes)}`, description: `${project.name} › ${s.name} is using a lot of memory for a dev service.`,
        reason: 'Dev servers with file watchers or hot reload often grow over long sessions.',
        recommendedAction: 'Restart the service to release memory.',
      });
      if (s.type === 'database' && s.port && s.status !== 'RUNNING' && !input.ports.some(p => p.port === s.port)) push({
        id: `db:${s.id}`, severity: 'warning', projectId: project.id, serviceId: s.id, port: s.port,
        title: 'Database unreachable', description: `Nothing is listening on port ${s.port} for ${project.name} › ${s.name}.`,
        reason: 'Services that depend on this database will fail to connect.',
        recommendedAction: 'Start the database (or its container) before the app.',
      });
    }

    const env = input.env.get(project.id);
    const missing = env?.rows.filter(r => r.status === 'missing' || r.status === 'empty') ?? [];
    if (missing.length) push({
      id: `env:${project.id}`, severity: 'warning', projectId: project.id, serviceId: null,
      title: `${missing.length} environment variable${missing.length > 1 ? 's' : ''} missing`,
      description: `${project.name}: ${missing.slice(0, 4).map(r => r.key).join(', ')}${missing.length > 4 ? '…' : ''} ${missing.length > 1 ? 'are' : 'is'} in ${env!.expectedFrom} but not set.`,
      reason: 'The project declares these variables as expected configuration.',
      recommendedAction: `Add them to .env or .env.local (DevNEX never edits these files).`,
    });

    for (const r of input.runtime.get(project.id) ?? []) {
      if (r.status !== 'mismatch' && r.status !== 'missing') continue;
      push({
        id: `runtime:${project.id}:${r.tool}`, severity: 'warning', projectId: project.id, serviceId: null,
        title: r.status === 'missing' ? `${r.tool} is not installed` : 'Runtime version mismatch',
        description: `${project.name} requires ${r.tool} ${r.required} (${r.source}); installed: ${r.installed ?? 'none'}.`,
        reason: 'Builds and dependencies can behave differently on another major version.',
        recommendedAction: `Switch to ${r.tool} ${r.required} with your version manager (DevNEX does not install runtimes).`,
      });
    }
  }

  for (const c of input.containers) {
    if (c.state !== 'exited' || !/Exited \((?!0\))/.test(c.status)) continue;
    push({
      id: `container:${c.id}`, severity: 'warning', projectId: c.projectId, serviceId: null,
      title: `Container ${c.name} exited`, description: `${c.name} (${c.image}) — ${c.status}.`,
      reason: 'A non-zero exit code means the container stopped because of an error.',
      recommendedAction: 'Check `docker logs` for the container, then start it again.',
    });
  }

  for (const port of input.ports) {
    const proc = port.pid ? input.processes.get(port.pid) : undefined;
    if (!proc || !DEV_RUNTIME.test(proc.name)) continue;
    // Orphan: a dev server whose parent shell/terminal is gone (re-parented to launchd/init).
    if (proc.ppid === 1 && port.projectId) push({
      id: `orphan:${port.pid}`, severity: 'warning', projectId: port.projectId, serviceId: port.serviceId, port: port.port, pid: port.pid ?? undefined,
      title: `Orphaned dev server on port ${port.port}`,
      description: `${proc.name} (PID ${port.pid}) from ${port.projectName} is still running but its terminal is gone.`,
      reason: 'The process outlived the terminal that started it, so nothing will stop it on its own.',
      recommendedAction: 'Stop it if you are no longer working on this project.',
    });
    if (port.exposure === 'network') push({
      id: `exposed:${port.port}`, severity: 'info', projectId: port.projectId, serviceId: port.serviceId, port: port.port, pid: port.pid ?? undefined,
      title: `Port ${port.port} is reachable from your network`,
      description: `${proc.name} listens on ${port.address}:${port.port}, not only on localhost.`,
      reason: 'Other devices on the same Wi-Fi can reach this dev server.',
      recommendedAction: 'Bind the dev server to 127.0.0.1 (e.g. --host 127.0.0.1 / -H 127.0.0.1) unless you need LAN access.',
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
