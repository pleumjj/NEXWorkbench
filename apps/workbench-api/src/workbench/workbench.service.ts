import { Injectable } from '@nestjs/common';
import { workbenchVersion, workspaceRoot, dataDir, PORTS, type WorkbenchPreferences } from '@nex/config';
import { workspaceState, type AttentionItem, type ContinueWorkingItem, type ModuleStatus, type NexCommand, type NexModule, type WorkspaceState } from '@nex/shared';
import { CoreService } from '../core/core.service';
import { MemnexService } from '../memnex/memnex.service';
import { DevnexService } from '../devnex/devnex.service';
import { WorknexService } from '../worknex/worknex.service';
import { FilenexService } from '../filenex/filenex.service';

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** A module that throws or hangs must never take the Workbench down with it. */
async function settle<T>(work: () => Promise<T>, ms = 8000): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not answer within ${ms / 1000}s`)), ms); }),
    ]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  } finally { clearTimeout(timer); }
}

const RANK = { critical: 0, warning: 1, info: 2 } as const;

export type WorkbenchSummary = {
  state: WorkspaceState;
  statusText: string;
  modules: ModuleStatus[];
  attention: AttentionItem[];
  continueWorking: ContinueWorkingItem[];
  activity: ReturnType<CoreService['activity']['toArray']>;
  preferences: WorkbenchPreferences;
  platform: string;
  version: string;
  updatedAt: string;
};

/**
 * Workbench aggregation. Each module decides what is wrong in its own domain;
 * the Workbench only collects, orders and routes (never re-detects).
 */
@Injectable()
export class WorkbenchService {
  constructor(private readonly core: CoreService, private readonly memnex: MemnexService, private readonly devnex: DevnexService, private readonly worknex: WorknexService, private readonly filenex: FilenexService) {}

  /** All modules, in sidebar order. */
  get all(): NexModule[] { return [this.memnex.module, this.devnex.module, this.worknex.module, this.filenex.module]; }
  enabled(): NexModule[] {
    const off = new Set(this.core.preferences.get().disabledModules);
    return this.all.filter(m => !off.has(m.id));
  }

  async summary(): Promise<WorkbenchSummary> {
    const modules = this.enabled();
    const results = await Promise.all(modules.map(async m => {
      const [status, attention] = await Promise.all([settle(() => m.getStatus()), settle(() => m.getAttentionItems())]);
      return { m, status, attention };
    }));

    const statuses: ModuleStatus[] = results.map(({ m, status }) => status.ok ? status.value : {
      id: m.id, name: m.name, tagline: m.description, route: m.route, state: 'unavailable',
      headline: `${m.name} status unavailable`, metrics: [], detail: status.error,
    });
    const attention: AttentionItem[] = results.flatMap(({ m, status, attention }) => {
      if (attention.ok) return attention.value;
      // Only report once per module, and only if status also failed to come back.
      return status.ok ? [] : [{
        id: `${m.id}:unavailable`, sourceModule: m.name, severity: 'warning' as const, title: `${m.name} is not answering`,
        description: `The Workbench could not read ${m.name}: ${attention.error}. Other modules keep working.`, action: m.route, actionLabel: `Open ${m.name}`, timestamp: new Date().toISOString(),
      }];
    }).sort((a, b) => RANK[a.severity] - RANK[b.severity]);

    const state = workspaceState(attention);
    const needs = attention.filter(a => a.severity !== 'info').length;
    const statusText = state === 'Healthy' ? 'Everything is running normally.'
      : state === 'Critical' ? `${attention.filter(a => a.severity === 'critical').length} critical item${attention.filter(a => a.severity === 'critical').length === 1 ? '' : 's'} need${attention.filter(a => a.severity === 'critical').length === 1 ? 's' : ''} attention now.`
      : `${needs} item${needs === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} review.`;

    const cont = await settle(() => this.continueWorking(modules.map(m => m.id)));

    return {
      state, statusText, modules: statuses, attention,
      continueWorking: cont.ok ? cont.value : [],
      activity: this.core.activity.toArray().reverse().slice(0, 12),
      preferences: this.core.preferences.get(),
      platform: this.core.platform.id,
      version: workbenchVersion(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * "Continue working" on Home. WorkNEX owns work continuity; when it is off, DevNEX's running projects are the fallback.
   * The Workbench only picks the source — it never re-derives contexts itself.
   */
  private async continueWorking(enabled: string[]): Promise<ContinueWorkingItem[]> {
    if (enabled.includes('worknex')) return this.worknex.module.getContinueWorkingItems();
    if (!enabled.includes('devnex')) return [];
    const items = await this.devnex.module.continueWorking();
    return items.map(p => ({
      id: p.projectId, title: p.name, subtitle: undefined, sourceModule: 'DevNEX', lastActiveAt: null, isActive: true,
      branch: p.branch, path: p.path, services: p.running, route: p.route,
    }));
  }

  /** Command palette entries: Workbench navigation + whatever each module offers. */
  async commands(): Promise<NexCommand[]> {
    const base: NexCommand[] = [
      { id: 'workbench.home', title: 'Go to Home', group: 'NEX Workbench', route: '/', keywords: 'workbench attention status' },
      { id: 'workbench.settings', title: 'Workbench settings', group: 'NEX Workbench', route: '/settings', keywords: 'theme preferences modules' },
    ];
    const lists = await Promise.all(this.enabled().map(m => (m.getCommands ? settle(() => m.getCommands!()) : Promise.resolve({ ok: true as const, value: [] as NexCommand[] }))));
    return [...base, ...lists.flatMap(l => (l.ok ? l.value : []))];
  }

  settings() {
    return {
      preferences: this.core.preferences.get(),
      modules: this.all.map(m => ({ id: m.id, name: m.name, description: m.description, route: m.route })),
      version: workbenchVersion(),
      platform: this.core.platform.id,
      dataLocations: { workbench: dataDir('nex'), memnex: dataDir('memnex'), devnex: dataDir('devnex') },
      root: workspaceRoot(),
      ports: { web: PORTS.web, api: PORTS.api },
      startedAt: this.core.startedAt,
    };
  }

  updatePreferences(patch: Partial<WorkbenchPreferences>) {
    const known = new Set(this.all.map(m => m.id));
    return this.core.preferences.update(p => ({
      disabledModules: Array.isArray(patch.disabledModules) ? patch.disabledModules.filter(id => known.has(id)) : p.disabledModules,
      refresh: patch.refresh === 'relaxed' || patch.refresh === 'normal' ? patch.refresh : p.refresh,
      language: patch.language === 'system' || patch.language === 'en' || patch.language === 'th' ? patch.language : p.language,
    }));
  }
}
