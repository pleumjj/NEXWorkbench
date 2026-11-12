import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { dataDir, workspaceRoot } from '@nex/config';
import { gitInfo } from '@nex/devnex';
import { groupProcesses } from '@nex/process-core';
import { WorknexEngine, createWorknexModule, type KnownProject, type WorkContext } from '@nex/worknex';
import { CoreService } from '../core/core.service';
import { DevnexService } from '../devnex/devnex.service';

/**
 * Wiring only — WorkNEX behaviour lives in @nex/worknex.
 * Project knowledge comes from DevNEX; process/RAM data from the shared process core; foreground reads are shared with MemNEX.
 */
@Injectable()
export class WorknexService implements OnModuleInit, OnModuleDestroy {
  readonly engine: WorknexEngine;
  readonly module;

  constructor(readonly core: CoreService, private readonly devnex: DevnexService) {
    const projects = () => this.knownProjects();
    this.engine = new WorknexEngine({
      platform: core.platform,
      dataDir: dataDir('worknex'),
      workspaceRoot: workspaceRoot(),
      directory: { projects, gitBranch: async path => { const g = await gitInfo(path); return g.isRepo ? g.branch : null; } },
      emit: (type, data) => core.bus.publish(type, data),
      resourceUsage: c => this.memoryOf(c),
    });
    this.module = createWorknexModule(this.engine, projects);
  }

  /** DevNEX's projects, reduced to what WorkNEX needs (DevNEX caches its own scan). */
  private async knownProjects(): Promise<KnownProject[]> {
    const list = await this.devnex.engine.projects();
    return list.map(p => ({ id: p.id, name: p.name, path: p.path, services: p.services.map(s => ({ name: s.name, port: s.port, running: s.status === 'RUNNING' })) }));
  }

  /** Approximate RAM of a context: its apps (shared process grouping) + its DevNEX project's dev processes. */
  private async memoryOf(c: WorkContext): Promise<number | null> {
    const names = new Set(c.applications.map(a => a.name.toLowerCase()));
    const groups = groupProcesses(await this.core.platform.listProcesses(), { selfRoot: workspaceRoot(), selfPid: process.pid, systemName: 'system' });
    let bytes = groups.filter(g => g.kind === 'app' && names.has(g.name.toLowerCase())).reduce((n, g) => n + g.memory, 0);
    if (c.projectId) bytes += (await this.devnex.engine.projects()).find(p => p.id === c.projectId)?.usage.memoryBytes ?? 0;
    return bytes || null;
  }

  onModuleInit() { this.engine.start(); }
  onModuleDestroy() { this.engine.stop(); }
}
