import { join, resolve, sep } from 'node:path';
import type { PortInfo, ProcessInfo } from '@nex/shared';
import { ActionError, type PlatformAdapter } from '@nex/platform-core';
import { ProcessController, ancestorsOf, classifyProcess, descendantsOf } from '@nex/process-core';
import { SystemMonitor } from '@nex/system-core';
import type { Container, DevnexOverview, ProjectUsage, DockerInfo, EnvReport, GitInfo, HealthIssue, PortConflict, PortEntry, Project, RuntimeCheck, RuntimeTool, Service, ServiceDefinition, ServiceStatus } from './types';
import { DevnexError } from './errors';
import { findProjectRoot, packageManagerOf, projectId, projectName, scanRoot, signalsOf } from './project-engine/discovery';
import { serviceDefinitions } from './project-engine/services';
import { ProjectRegistry } from './project-engine/registry';
import { ServiceRunner } from './project-engine/runner';
import { buildPortTable, findConflicts, projectForPid } from './port-engine';
import { inspectEnvironment } from './environment-engine';
import { checkRuntimes, detectRuntimes } from './runtime-engine';
import { gitInfo } from './git-engine';
import { dockerInfo } from './docker-engine';
import { evaluateHealth } from './service-health';

const SCAN_TTL_MS = 2500;
const DOCKER_TTL_MS = 10_000;
const STARTING_GRACE_MS = 60_000;

export type Scan = {
  at: string;
  processes: Map<number, ProcessInfo>;
  projects: Project[];
  ports: PortEntry[];
  conflicts: PortConflict[];
  docker: DockerInfo;
  runtimes: RuntimeTool[];
  env: Map<string, EnvReport>;
  runtimeChecks: Map<string, RuntimeCheck[]>;
  issues: HealthIssue[];
  system: Awaited<ReturnType<SystemMonitor['sample']>>;
};

export type DevnexEngineOptions = {
  platform: PlatformAdapter;
  dataDir: string;
  /** NEX Workbench root: no process running from here may be stopped from DevNEX (MemNEX applies the same rule). */
  workspaceRoot: string;
  /** Optional event sink (SSE): devnex.service.*, devnex.port.conflict, devnex.log */
  emit?: (type: string, data: unknown) => void;
  /** Shared system monitor (one RAM/CPU reader for the whole Workbench). Created if omitted. */
  system?: SystemMonitor;
  /** Protected applications (shared with MemNEX): DevNEX never stops these. */
  isProtected?: (name: string) => boolean;
};

/** "Cannot start frontend. Port 3000 is already in use. Owner: node · PID 18342 · Project: old-test-project." */
export const conflictMessage = (c: PortConflict) =>
  `Cannot start ${c.requestedBy.serviceName}. Port ${c.port} is already in use. Owner: ${c.usedBy.processName ?? 'unknown process'}${c.usedBy.pid ? ` · PID ${c.usedBy.pid}` : ''}${c.usedBy.projectName ? ` · Project: ${c.usedBy.projectName}` : ' · not tied to a known project'}. Nothing was stopped — free the port or change the service’s port.`;

const STATUS_RANK: Record<ServiceStatus, number> = { FAILED: 5, WARNING: 4, STARTING: 3, RUNNING: 2, UNKNOWN: 1, STOPPED: 0 };

/** DevNEX business logic behind one facade; the API only routes HTTP here. */
export class DevnexEngine {
  readonly registry: ProjectRegistry;
  readonly runner: ServiceRunner;
  private readonly system: SystemMonitor;
  private readonly control: ProcessController;
  private scanCache: { at: number; promise: Promise<Scan> } | null = null;
  private dockerCache: { at: number; value: DockerInfo } | null = null;
  private knownConflicts = new Set<string>();
  private defs = new Map<string, { def: ServiceDefinition; projectId: string; projectPath: string }>();

  constructor(private readonly opts: DevnexEngineOptions) {
    this.registry = new ProjectRegistry(join(opts.dataDir, 'projects.json'));
    this.runner = new ServiceRunner(opts.platform);
    this.system = opts.system ?? new SystemMonitor(opts.platform);
    this.control = new ProcessController(opts.platform);
    this.runner.onLog((serviceId, line) => opts.emit?.('devnex.log', { serviceId, line }));
    this.runner.onExit((serviceId, code, requested) => {
      this.scanCache = null;
      opts.emit?.(requested || code === 0 ? 'devnex.service.stopped' : 'devnex.service.failed', { serviceId, exitCode: code });
    });
  }

  private emit(type: string, data: unknown) { this.opts.emit?.(type, data); }

  /** One coherent picture of the local dev environment, cached briefly so every page reads the same scan. */
  scan(force = false): Promise<Scan> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache.promise;
    const promise = this.doScan();
    this.scanCache = { at: Date.now(), promise };
    promise.catch(() => { this.scanCache = null; });
    return promise;
  }

  private async docker(): Promise<DockerInfo> {
    if (this.dockerCache && Date.now() - this.dockerCache.at < DOCKER_TTL_MS) return this.dockerCache.value;
    const value = await dockerInfo();
    this.dockerCache = { at: Date.now(), value };
    return value;
  }

  private async doScan(): Promise<Scan> {
    const [raw, rawPorts, system, docker, runtimes] = await Promise.all([
      this.opts.platform.listProcesses(), this.opts.platform.listeningPorts(), this.system.sample(), this.docker(), detectRuntimes(),
    ]);
    const processes = new Map(raw.map(p => [p.pid, p]));

    // Working directories for listening processes and a few ancestors (npm → node → next-server).
    const interesting = new Set<number>();
    for (const port of rawPorts) if (port.pid) for (const pid of [...ancestorsOf(raw, port.pid)].slice(0, 4)) interesting.add(pid);
    for (const id of this.defs.keys()) { const run = this.runner.get(id); if (run && !run.exited) interesting.add(run.pid); }
    const cwds = await this.opts.platform.processCwds([...interesting]);

    // Projects: registered + found under registered roots + detected from running servers.
    const reg = this.registry.get();
    const hidden = new Set(reg.hidden);
    const registered = new Set<string>([...reg.projects, ...reg.roots.flatMap(r => scanRoot(r))]);
    const detected = new Set<string>();
    for (const port of rawPorts) {
      const cwd = port.pid ? cwds.get(port.pid) : undefined;
      const root = cwd ? findProjectRoot(cwd) : null;
      if (root && !registered.has(root)) detected.add(root);
    }
    const paths: { path: string; origin: Project['origin'] }[] = [
      ...[...registered].map(p => ({ path: p, origin: 'registered' as const })),
      ...[...detected].map(p => ({ path: p, origin: 'detected' as const })),
    ].filter(p => !hidden.has(p.path));

    const projects: Project[] = paths.map(({ path, origin }) => {
      const id = projectId(path);
      const defs = serviceDefinitions(path, id);
      for (const def of defs) this.defs.set(def.id, { def, projectId: id, projectPath: path });
      return { id, name: projectName(path), path, origin, self: resolve(path) === resolve(this.opts.workspaceRoot), signals: signalsOf(path), packageManager: packageManagerOf(path), services: defs.map(d => this.blankService(d, id)), status: 'STOPPED' as ServiceStatus, usage: { cpuPercent: 0, memoryBytes: 0, processCount: 0, basis: 'none' as const } };
    });

    const ctx = { processes, cwds, projects };
    const table = buildPortTable(rawPorts, ctx);
    for (const project of projects) this.resolveServices(project, { raw, rawPorts, table, docker, ctx });
    // Port → service names may change once services are resolved (port-less script services adopt their port).
    const ports = buildPortTable(rawPorts, ctx);
    for (const project of projects) project.usage = this.usageOf(project, raw, ports);
    for (const project of projects) project.status = project.services.reduce<ServiceStatus>((s, x) => (STATUS_RANK[x.status] > STATUS_RANK[s] ? x.status : s), 'STOPPED');

    const containers: Container[] = docker.containers.map(c => ({ ...c, projectId: projects.find(p => (c.workingDir && (c.workingDir === p.path || c.workingDir.startsWith(p.path + sep)))
      || (c.composeProject && c.composeProject === p.path.split(sep).pop()?.toLowerCase()))?.id ?? null }));

    const conflicts = findConflicts(ports, projects);
    for (const c of conflicts) {
      const key = `${c.port}:${c.requestedBy.serviceId}`;
      if (!this.knownConflicts.has(key)) this.emit('devnex.port.conflict', c);
    }
    this.knownConflicts = new Set(conflicts.map(c => `${c.port}:${c.requestedBy.serviceId}`));

    const env = new Map(projects.map(p => [p.id, inspectEnvironment(p.id, p.path)] as const));
    const runtimeChecks = new Map(projects.map(p => [p.id, checkRuntimes(p.path, runtimes)] as const));
    const issues = evaluateHealth({ projects, conflicts, ports, processes, env, runtime: runtimeChecks, containers });

    return { at: system.at, processes, projects, ports, conflicts, docker: { ...docker, containers }, runtimes, env, runtimeChecks, issues, system };
  }

  /** Sum CPU/RAM over every process tree tied to the project (each pid counted once). */
  private usageOf(project: Project, raw: ProcessInfo[], ports: PortEntry[]): ProjectUsage {
    const exact = new Set<number>(), inferred = new Set<number>();
    for (const s of project.services) {
      if (!s.pid) continue;
      const target = s.managedBy === 'devnex' ? exact : inferred;
      target.add(s.pid); descendantsOf(raw, s.pid).forEach(p => target.add(p));
    }
    for (const e of ports) {
      if (e.projectId !== project.id || !e.pid || exact.has(e.pid)) continue;
      inferred.add(e.pid); descendantsOf(raw, e.pid).forEach(p => inferred.add(p));
    }
    const all = new Set([...exact, ...inferred]);
    const procs = raw.filter(p => all.has(p.pid));
    const basis = !all.size ? 'none' : !inferred.size ? 'devnex' : !exact.size ? 'inferred' : 'mixed';
    return { cpuPercent: procs.reduce((n, p) => n + p.cpu, 0), memoryBytes: procs.reduce((n, p) => n + p.memory, 0), processCount: procs.length, basis };
  }

  private blankService(def: ServiceDefinition, projectId: string): Service {
    return { ...def, projectId, status: 'STOPPED', managedBy: null, hasLogs: !!this.runner.get(def.id), pid: null, cpuPercent: null, memoryBytes: null, startedAt: null, exitCode: null, health: 'unknown', detail: null };
  }

  /** Decide each service's state from: DevNEX-managed run → listening port → containers. */
  private resolveServices(project: Project, s: { raw: ProcessInfo[]; rawPorts: PortInfo[]; table: PortEntry[]; docker: DockerInfo; ctx: Parameters<typeof projectForPid>[1] }) {
    const usage = (pid: number) => {
      const tree = [pid, ...descendantsOf(s.raw, pid)];
      const procs = tree.map(p => s.ctx.processes.get(p)).filter((p): p is ProcessInfo => !!p);
      return { cpuPercent: procs.reduce((n, p) => n + p.cpu, 0), memoryBytes: procs.reduce((n, p) => n + p.memory, 0) };
    };
    const projectPorts = s.table.filter(e => e.projectId === project.id);
    const claimed = new Set(project.services.map(x => x.port).filter(Boolean));
    const unclaimed = projectPorts.filter(e => !claimed.has(e.port));

    for (const svc of project.services) {
      const run = this.runner.get(svc.id);
      if (svc.source === 'docker-compose') {
        const mine = s.docker.containers.filter(c => c.workingDir === project.path || c.composeProject === project.path.split(sep).pop()?.toLowerCase());
        if (!s.docker.available) Object.assign(svc, { status: 'UNKNOWN', detail: s.docker.detail });
        else if (mine.some(c => c.state === 'running')) Object.assign(svc, { status: 'RUNNING', health: 'ok', managedBy: 'external', detail: `${mine.filter(c => c.state === 'running').length} of ${mine.length} containers running` });
        else if (mine.some(c => /Exited \((?!0\))/.test(c.status))) Object.assign(svc, { status: 'FAILED', health: 'failed', detail: 'A container exited with an error.' });
        else Object.assign(svc, { status: 'STOPPED', detail: mine.length ? 'Containers are stopped.' : 'No containers for this project.' });
        continue;
      }
      // A port-less script service adopts the project's only unclaimed listening port.
      const portEntry = svc.port ? projectPorts.find(e => e.port === svc.port)
        : project.services.filter(x => !x.port && x.source !== 'docker-compose').length === 1 && unclaimed.length === 1 ? unclaimed[0] : undefined;
      if (portEntry && !svc.port) svc.port = portEntry.port;

      if (run && !run.exited) {
        const age = Date.now() - new Date(run.startedAt).getTime();
        const listening = !svc.port || !!portEntry;
        const status: ServiceStatus = listening ? 'RUNNING' : age < STARTING_GRACE_MS ? 'STARTING' : 'WARNING';
        Object.assign(svc, { status, managedBy: 'devnex', pid: run.pid, startedAt: run.startedAt, health: status === 'RUNNING' ? 'ok' : status === 'WARNING' ? 'warning' : 'unknown',
          detail: status === 'WARNING' ? `Started ${Math.round(age / 1000)}s ago but port ${svc.port} is not listening.` : null, ...usage(run.pid) });
      } else if (portEntry?.pid) {
        Object.assign(svc, { status: 'RUNNING', managedBy: 'external', pid: portEntry.pid, health: 'ok', detail: 'Running outside DevNEX — logs are only available for services DevNEX starts.', ...usage(portEntry.pid) });
      } else if (run?.exited) {
        const failed = !run.stopRequested && run.exitCode !== 0;
        Object.assign(svc, { status: failed ? 'FAILED' : 'STOPPED', exitCode: run.exitCode, health: failed ? 'failed' : 'unknown', startedAt: run.startedAt });
      } else if (!svc.port && svc.command) {
        Object.assign(svc, { status: 'UNKNOWN', detail: 'No port declared — DevNEX can’t tell if it runs outside DevNEX.' });
      }
    }
  }

  /* ── Read models ── */

  async overview(): Promise<DevnexOverview> {
    const s = await this.scan();
    const services = s.projects.flatMap(p => p.services);
    const devPids = new Set(s.ports.filter(p => p.projectId && p.pid).map(p => p.pid!));
    const devProcs = [...devPids].map(pid => s.processes.get(pid)).filter((p): p is ProcessInfo => !!p);
    const m = s.system.memory;
    return {
      system: { memory: { total: m.total, used: m.used, available: m.available, percent: (m.used / m.total) * 100 }, cpu: s.system.cpu, swap: m.swap },
      counts: {
        projects: s.projects.length, services: services.length, running: services.filter(x => x.status === 'RUNNING').length,
        failed: services.filter(x => x.status === 'FAILED').length, ports: s.ports.length, unknownPorts: s.ports.filter(p => p.unknown).length,
        conflicts: s.conflicts.length, issues: s.issues.filter(i => i.severity !== 'info').length,
      },
      devProcesses: { count: devProcs.length, memory: devProcs.reduce((n, p) => n + p.memory, 0), cpu: devProcs.reduce((n, p) => n + p.cpu, 0) },
      projects: s.projects,
      issues: s.issues,
      docker: { available: s.docker.available, running: s.docker.containers.filter(c => c.state === 'running').length, exited: s.docker.containers.filter(c => c.state === 'exited').length },
      runtimes: s.runtimes,
      updatedAt: s.at,
    };
  }

  async projects() { return (await this.scan()).projects; }

  async projectDetail(id: string): Promise<{ project: Project; git: GitInfo; env: EnvReport; runtime: RuntimeCheck[]; containers: Container[]; issues: HealthIssue[]; ports: PortEntry[] }> {
    const s = await this.scan();
    const project = s.projects.find(p => p.id === id);
    if (!project) throw new DevnexError('not_found', 'Project not found. It may have been removed or its folder moved.');
    return {
      project, git: await gitInfo(project.path), env: s.env.get(id)!, runtime: s.runtimeChecks.get(id) ?? [],
      containers: s.docker.containers.filter(c => c.projectId === id), issues: s.issues.filter(i => i.projectId === id), ports: s.ports.filter(p => p.projectId === id),
    };
  }

  async ports() { const s = await this.scan(); return { ports: s.ports, conflicts: s.conflicts, updatedAt: s.at }; }

  async environment() {
    const s = await this.scan();
    return { runtimes: s.runtimes, projects: s.projects.map(p => ({ id: p.id, name: p.name, env: s.env.get(p.id)!, runtime: s.runtimeChecks.get(p.id) ?? [] })), docker: s.docker, updatedAt: s.at };
  }

  logs(serviceId: string) {
    const known = this.defs.get(serviceId);
    if (!known) throw new DevnexError('not_found', 'Service not found.');
    return { serviceId, name: known.def.name, managed: !!this.runner.get(serviceId), lines: this.runner.logs(serviceId) };
  }
  clearLogs(serviceId: string) { this.runner.clearLogs(serviceId); return { ok: true }; }

  /* ── Actions (never automatic) ── */

  private definition(serviceId: string) {
    const known = this.defs.get(serviceId);
    if (!known) throw new DevnexError('not_found', 'Service not found. Refresh and try again.');
    return known;
  }

  private assertNotSelf(projectPath: string) {
    if (resolve(projectPath) === resolve(this.opts.workspaceRoot)) throw new DevnexError('forbidden', 'This is NEX Workbench itself. Start or stop it from the terminal running npm run dev.');
  }

  async start(serviceId: string) {
    const { def, projectPath } = this.definition(serviceId);
    this.assertNotSelf(projectPath);
    if (!def.command) throw new DevnexError('unprocessable', def.source === 'docker-compose' ? 'Start compose services with `docker compose up` — DevNEX v1 does not manage containers.' : 'This service has no command. Add one in devnex.config.json.');
    if (this.runner.isRunning(serviceId)) throw new DevnexError('conflict', 'This service is already running.');
    const s = await this.scan(true);
    const svc = s.projects.flatMap(p => p.services).find(x => x.id === serviceId);
    if (svc?.status === 'RUNNING') throw new DevnexError('conflict', `${def.name} is already running outside DevNEX (PID ${svc.pid}).`);
    const conflict = s.conflicts.find(c => c.requestedBy.serviceId === serviceId);
    if (conflict) throw new DevnexError('conflict', conflictMessage(conflict));
    try { this.runner.start(serviceId, def.command, projectPath); } catch (e) { throw new DevnexError('unprocessable', (e as Error).message); }
    this.scanCache = null;
    this.emit('devnex.service.started', { serviceId });
    return { ok: true, serviceId };
  }

  async stop(serviceId: string) {
    const { def, projectPath } = this.definition(serviceId);
    this.assertNotSelf(projectPath);
    if (this.runner.isRunning(serviceId)) {
      await this.runner.stop(serviceId);
      this.scanCache = null;
      return { ok: true, serviceId, stopped: 'devnex' };
    }
    // Running outside DevNEX: stop its process (graceful) — the UI asks for confirmation first.
    const s = await this.scan(true);
    const svc = s.projects.flatMap(p => p.services).find(x => x.id === serviceId);
    if (!svc?.pid) throw new DevnexError('conflict', `${def.name} is not running.`);
    return this.stopProcess(svc.pid);
  }

  async restart(serviceId: string) {
    if (this.runner.isRunning(serviceId)) {
      await this.runner.stop(serviceId);
      const until = Date.now() + 8000;
      while (this.runner.isRunning(serviceId) && Date.now() < until) await new Promise(r => setTimeout(r, 200));
      if (this.runner.isRunning(serviceId)) throw new DevnexError('conflict', 'The service did not stop, so it was not restarted.');
    }
    return this.start(serviceId);
  }

  /**
   * Graceful stop of a process found on a port (e.g. "Stop existing process" in a conflict).
   * Refuses OS processes, other users' processes and NEX itself. Never escalates to force.
   */
  async stopProcess(pid: number) {
    if (!Number.isInteger(pid) || pid < 2) throw new DevnexError('bad_request', 'Invalid process ID.');
    const s = await this.scan(true);
    const proc = s.processes.get(pid);
    if (!proc) throw new DevnexError('not_found', 'Process no longer exists.');
    const all = [...s.processes.values()];
    const nex = pid === process.pid || ancestorsOf(all, process.pid).has(pid)
      || [...ancestorsOf(all, pid)].some(a => s.processes.get(a)?.command.includes(this.opts.workspaceRoot + sep));
    if (nex) throw new DevnexError('forbidden', 'That process belongs to NEX Workbench itself. Stop it from the terminal running npm run dev.');
    // Same rules as MemNEX: OS processes (process-core classifier) and the user's protected apps are never stopped.
    const identity = classifyProcess(proc, { selfRoot: this.opts.workspaceRoot, selfPid: process.pid, systemName: 'system' });
    if (identity.kind === 'system') throw new DevnexError('forbidden', 'System protected. DevNEX only stops your own development processes.');
    if (this.opts.isProtected?.(identity.name)) throw new DevnexError('forbidden', `${identity.name} is protected in MemNEX settings. Unprotect it there first.`);
    try {
      const { stillRunning } = await this.control.stopProcess(pid);
      this.scanCache = null;
      return { ok: true, pid, stillRunning, detail: stillRunning ? 'The process did not exit after a normal stop request. Stop it from its own terminal.' : undefined };
    } catch (e) {
      throw new DevnexError(e instanceof ActionError && e.code === 'permission' ? 'forbidden' : 'unprocessable', (e as Error).message);
    }
  }

  /**
   * Start every stopped service of a project. All ports are validated first:
   * if any is taken, nothing starts and the reason is explained (nothing is ever stopped automatically).
   */
  async startProject(id: string) {
    const s = await this.scan(true);
    const project = s.projects.find(p => p.id === id);
    if (!project) throw new DevnexError('not_found', 'Project not found.');
    this.assertNotSelf(project.path);
    const todo = project.services.filter(x => x.command && (x.status === 'STOPPED' || x.status === 'FAILED'));
    if (!todo.length) throw new DevnexError('conflict', project.services.some(x => x.command) ? 'Every startable service is already running.' : 'This project has no services DevNEX can start. Add dev scripts or a devnex.config.json.');
    const blocked = s.conflicts.filter(c => todo.some(x => x.id === c.requestedBy.serviceId));
    if (blocked.length) throw new DevnexError('conflict', blocked.map(conflictMessage).join(' '));
    const dupPorts = todo.map(x => x.port).filter((p, i, a) => p && a.indexOf(p) !== i);
    if (dupPorts.length) throw new DevnexError('conflict', `Two services in ${project.name} declare port ${dupPorts[0]}. Fix devnex.config.json first.`);
    const started: string[] = [], failed: { name: string; reason: string }[] = [];
    for (const svc of todo) {
      try { await this.start(svc.id); started.push(svc.name); } catch (e) { failed.push({ name: svc.name, reason: (e as Error).message }); }
    }
    return { ok: !failed.length, started, failed };
  }

  /** Stop every running service of a project (graceful; services running outside DevNEX get a normal stop request). */
  async stopProject(id: string) {
    const s = await this.scan(true);
    const project = s.projects.find(p => p.id === id);
    if (!project) throw new DevnexError('not_found', 'Project not found.');
    this.assertNotSelf(project.path);
    const running = project.services.filter(x => x.source !== 'docker-compose' && ['RUNNING', 'STARTING', 'WARNING'].includes(x.status));
    if (!running.length) throw new DevnexError('conflict', `${project.name} has no running services.`);
    const stopped: string[] = [], failed: { name: string; reason: string }[] = [];
    for (const svc of running) {
      try { await this.stop(svc.id); stopped.push(svc.name); } catch (e) { failed.push({ name: svc.name, reason: (e as Error).message }); }
    }
    this.scanCache = null;
    return { ok: !failed.length, stopped, failed };
  }

  /** Stop the project, wait until its services have exited, then start it again (ports are re-validated). */
  async restartProject(id: string) {
    try { await this.stopProject(id); } catch (e) { if (!(e instanceof DevnexError && e.code === 'conflict')) throw e; }
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const p = (await this.scan(true)).projects.find(x => x.id === id);
      if (!p?.services.some(x => x.source !== 'docker-compose' && ['RUNNING', 'STARTING', 'WARNING'].includes(x.status))) break;
      await new Promise(r => setTimeout(r, 400));
    }
    return this.startProject(id);
  }

  /** Reveal a known project's folder. Only paths DevNEX already knows — never an arbitrary path from a request. */
  async openFolder(id: string) {
    const project = (await this.scan()).projects.find(p => p.id === id);
    if (!project) throw new DevnexError('not_found', 'Project not found.');
    try { await this.opts.platform.openPath(project.path); } catch (e) { throw new DevnexError('unprocessable', (e as Error).message); }
    return { ok: true };
  }

  async addProject(path: string) {
    try { this.registry.addProject(path); } catch (e) { throw new DevnexError('bad_request', (e as Error).message); }
    this.scanCache = null;
    return this.registry.get();
  }
  async addRoot(path: string) {
    try { this.registry.addRoot(path); } catch (e) { throw new DevnexError('bad_request', (e as Error).message); }
    this.scanCache = null;
    return this.registry.get();
  }
  async removeProject(id: string) {
    const s = await this.scan();
    const p = s.projects.find(x => x.id === id);
    if (!p) throw new DevnexError('not_found', 'Project not found.');
    this.registry.remove(p.path);
    this.scanCache = null;
    return this.registry.get();
  }

  async shutdown() { await this.runner.stopAll(); }
}
