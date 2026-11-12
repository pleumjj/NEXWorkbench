import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { dataDir } from '@nex/config';
import { FilenexEngine, createFilenexModule, type ProjectActivity, type WorkContextRef } from '@nex/filenex';
import { gitInfo } from '@nex/devnex';
import { CoreService } from '../core/core.service';
import { DevnexService } from '../devnex/devnex.service';
import { WorknexService } from '../worknex/worknex.service';

/**
 * Wiring only — FileNEX behaviour lives in @nex/filenex.
 * WorkNEX contexts and DevNEX projects are read-only inputs: neither grants indexing permission.
 * System pressure comes from the shared system monitor (the same one MemNEX uses).
 */
@Injectable()
export class FilenexService implements OnModuleInit, OnModuleDestroy {
  readonly engine: FilenexEngine;
  readonly module;

  constructor(readonly core: CoreService, devnex: DevnexService, worknex: WorknexService) {
    this.engine = new FilenexEngine({
      platform: core.platform,
      dataDir: dataDir('filenex'),
      sources: {
        // Only what WorkNEX already kept under its own permissions (titles, file names/paths of tracked apps).
        contexts: async (): Promise<WorkContextRef[]> => worknex.engine.recent(100).map(c => ({
          id: c.id, title: c.title, type: c.type, projectId: c.projectId, projectPath: c.projectPath,
          startedAt: c.startedAt, lastActiveAt: c.lastActiveAt, isActive: c.isActive,
          files: c.files.map(f => ({ name: f.name, path: f.path })),
        })),
        projects: async () => (await devnex.engine.projects()).map(p => ({ id: p.id, name: p.name, path: p.path })),
        // DevNEX identifies projects (and what runs); FileNEX analyzes storage — only inside approved folders.
        projectActivity: async (): Promise<ProjectActivity[]> => {
          const scan = await devnex.engine.scan();
          return scan.projects.map(p => ({
            id: p.id, name: p.name, path: p.path, status: p.status,
            runningServices: p.services.filter(s => s.status === 'RUNNING' || s.status === 'STARTING' || s.status === 'WARNING').length,
            composeProjects: [...new Set(scan.docker.containers.filter(c => c.projectId === p.id && c.composeProject).map(c => c.composeProject!))],
          }));
        },
        git: async path => { const g = await gitInfo(path); return { isRepo: g.isRepo, branch: g.branch, changed: g.changed, untracked: g.untracked }; },
      },
      systemBusy: async () => {
        const s = await core.system.sample();
        return s.memory.pressure === 'warn' || s.memory.pressure === 'critical' || s.cpu.usage > 85;
      },
      systemLoad: async () => {
        const s = await core.system.sample();
        return { cpu: s.cpu.usage, memoryPressure: s.memory.pressure === 'warn' || s.memory.pressure === 'critical' };
      },
      emit: (type, data) => core.bus.publish(type, data),
    });
    this.module = createFilenexModule(this.engine);
  }

  onModuleInit() { this.engine.start(); }
  onModuleDestroy() { this.engine.stop(); }
}
