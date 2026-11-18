import type { AttentionItem, ModuleStatus, NexCommand, NexModule } from '@nex/shared';
import type { DevnexEngine } from './engine';
import type { HealthIssue } from './types';
import { gitInfo } from './git-engine';

const routeFor = (i: HealthIssue) =>
  i.id.startsWith('conflict:') || i.id.startsWith('exposed:') || i.id.startsWith('orphan:') ? `/devnex/ports${i.port ? `?port=${i.port}` : ''}`
    : i.id.startsWith('env:') || i.id.startsWith('runtime:') ? '/devnex/environment'
    : i.serviceId ? '/devnex/services' : '/devnex/projects';

export type ContinueItem = {
  projectId: string; name: string; path: string; branch: string | null; changed: number;
  running: { name: string; port: number | null }[]; status: string; route: string;
};

/** DevNEX as a Workbench module. */
export function createDevnexModule(engine: DevnexEngine): NexModule & { continueWorking(): Promise<ContinueItem[]> } {
  return {
    id: 'devnex', name: 'DevNEX', route: '/devnex', description: 'Local Developer Control Center',

    async getStatus(): Promise<ModuleStatus> {
      const o = await engine.overview();
      const critical = o.issues.some(i => i.severity === 'critical');
      const warning = o.issues.some(i => i.severity === 'warning');
      const runningProjects = o.projects.filter(p => p.services.some(s => s.status === 'RUNNING')).length;
      return {
        id: 'devnex', name: 'DevNEX', tagline: 'Local Developer Control Center', route: '/devnex',
        state: critical ? 'critical' : warning ? 'attention' : 'healthy',
        headline: critical ? o.issues.find(i => i.severity === 'critical')!.title : warning ? `${o.counts.issues} issue${o.counts.issues > 1 ? 's' : ''} to review` : 'Development environment is healthy.',
        metrics: [
          { label: 'Projects', value: `${runningProjects}/${o.counts.projects} running` },
          { label: 'Services', value: `${o.counts.running} running` },
          { label: 'Ports', value: String(o.counts.ports) },
          { label: 'Issues', value: String(o.counts.issues) },
        ],
        detail: o.docker.available ? `Docker · ${o.docker.running} running` : 'Docker unavailable',
      };
    },

    async getAttentionItems(): Promise<AttentionItem[]> {
      const o = await engine.overview();
      const agents = await engine.agentOverview().catch(() => null);
      // A port held by a leftover of an agent is explained by the agent item — don't say it twice.
      const agentPids = new Set(agents?.sessions.flatMap(s => s.leftovers.flatMap(l => [l.pid])) ?? []);
      const issues = o.issues.filter(i => i.severity !== 'info' && !(i.id.startsWith('orphan:') && i.pid && agentPids.has(i.pid))).map<AttentionItem>(i => ({
        id: `devnex:${i.id}`, sourceModule: 'DevNEX', severity: i.severity, title: i.title, description: i.description,
        action: routeFor(i), actionLabel: i.id.startsWith('conflict:') ? 'Resolve' : 'Review', timestamp: o.updatedAt,
      }));
      const fromAgents = (agents?.findings ?? []).filter(f => f.kind !== 'idle-heavy').map<AttentionItem>(f => ({
        id: `devnex:agents:${f.kind}:${f.kind === 'duplicate-servers' ? f.projectId : f.sessionId}`, sourceModule: 'DevNEX',
        severity: f.kind === 'leftovers' ? 'warning' : 'info', title: f.title, description: f.detail,
        action: '/devnex/agents', actionLabel: f.kind === 'leftovers' ? 'Stop leftovers' : 'Review', timestamp: agents!.updatedAt,
      }));
      return [...fromAgents, ...issues];
    },

    async getCommands(): Promise<NexCommand[]> {
      const o = await engine.overview();
      const base: NexCommand[] = ['Overview', 'Projects', 'Services', 'Agents', 'Ports', 'Logs', 'Environment', 'Settings'].map(s => ({
        id: `devnex.${s.toLowerCase()}`, title: s === 'Overview' ? 'Open DevNEX' : `DevNEX ${s}`, group: 'DevNEX', route: s === 'Overview' ? '/devnex' : `/devnex/${s.toLowerCase()}`,
      }));
      const projects = o.projects.map(p => ({ id: `devnex.project.${p.id}`, title: `Open ${p.name}`, group: 'Projects', route: `/devnex/projects?project=${p.id}`, keywords: p.path }));
      const services = o.projects.flatMap(p => p.services.filter(s => s.command).map(s => ({
        id: `devnex.service.${s.id}`, title: `${s.status === 'RUNNING' ? 'Restart' : 'Start'} ${p.name} › ${s.name}`, group: 'Services', route: `/devnex/services?service=${encodeURIComponent(s.id)}`, keywords: `${s.type} ${s.port ?? ''}`,
      })));
      const ports = (await engine.ports()).ports.filter(p => !p.unknown).map(p => ({ id: `devnex.port.${p.port}`, title: `Show port ${p.port}`, group: 'Ports', route: `/devnex/ports?port=${p.port}`, keywords: `${p.processName} ${p.projectName ?? ''}` }));
      return [...base, ...projects, ...services, ...ports];
    },

    /** Projects with something running, most active first — for "Continue working". */
    async continueWorking(): Promise<ContinueItem[]> {
      const o = await engine.overview();
      const active = o.projects.filter(p => p.services.some(s => s.status === 'RUNNING' || s.status === 'STARTING'))
        .sort((a, b) => b.services.filter(s => s.status === 'RUNNING').length - a.services.filter(s => s.status === 'RUNNING').length)
        .slice(0, 3);
      return Promise.all(active.map(async p => {
        const git = await gitInfo(p.path);
        return {
          projectId: p.id, name: p.name, path: p.path, branch: git.isRepo ? git.branch : null, changed: git.changed + git.untracked,
          running: p.services.filter(s => s.status === 'RUNNING').map(s => ({ name: s.name, port: s.port })), status: p.status,
          route: `/devnex/projects?project=${p.id}`,
        };
      }));
    },
  };
}
