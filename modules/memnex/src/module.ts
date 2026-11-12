import type { AttentionItem, ModuleStatus, NexCommand, NexModule } from '@nex/shared';
import type { MemnexEngine } from './engine';

const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** MemNEX as a Workbench module: it decides what is worth attention in its own domain. */
export function createMemnexModule(engine: MemnexEngine, maxAgeMs = 2000): NexModule {
  // Status + attention are read together by the Workbench: share one snapshot between them.
  let cache: { at: number; promise: ReturnType<MemnexEngine['snapshot']> } | null = null;
  const recent = () => {
    if (!cache || Date.now() - cache.at >= maxAgeMs) {
      cache = { at: Date.now(), promise: engine.snapshot() };
      cache.promise.catch(() => { cache = null; });
    }
    return cache.promise;
  };
  return {
    id: 'memnex', name: 'MemNEX', route: '/memnex', description: 'Local System Intelligence',

    async getStatus(): Promise<ModuleStatus> {
      const s = await recent();
      const state = s.memory.state === 'Critical' ? 'critical' : s.memory.state === 'High' ? 'attention' : 'healthy';
      return {
        id: 'memnex', name: 'MemNEX', tagline: 'Local System Intelligence', route: '/memnex', state,
        headline: s.insight.headline,
        metrics: [
          { label: 'System', value: s.memory.state },
          { label: 'Memory', value: `${s.memory.percent.toFixed(0)}%` },
          { label: 'CPU', value: `${s.cpu.usage.toFixed(0)}%` },
          { label: 'Idle apps', value: String(s.apps.filter(a => a.recommended || a.suggested).length) },
        ],
      };
    },

    async getAttentionItems(): Promise<AttentionItem[]> {
      const s = await recent();
      const items: AttentionItem[] = [];
      if (s.memory.state === 'High' || s.memory.state === 'Critical') {
        items.push({
          id: 'memnex:pressure', sourceModule: 'MemNEX', severity: s.memory.state === 'Critical' ? 'critical' : 'warning',
          title: s.memory.state === 'Critical' ? 'Memory pressure critical' : 'Memory pressure elevated',
          description: s.insight.headline, action: s.recommendations.length ? '/memnex/cleanup' : '/memnex', actionLabel: s.recommendations.length ? 'Review cleanup' : 'Open MemNEX', timestamp: s.updatedAt,
        });
      }
      const growing = s.apps.filter(a => a.growth && a.kind === 'app');
      for (const a of growing.slice(0, 2)) items.push({
        id: `memnex:growth:${a.id}`, sourceModule: 'MemNEX', severity: 'warning', title: `${a.name} keeps growing`,
        description: `+${fmt(a.growth!.bytes)} in ${a.growth!.minutes} min${a.growth!.top ? `, mostly in ${a.growth!.top.name}` : ''}.`,
        action: '/memnex/cleanup', actionLabel: 'Restart to reclaim', timestamp: s.updatedAt,
      });
      return items;
    },

    async getCommands(): Promise<NexCommand[]> {
      return [
        { id: 'memnex.overview', title: 'Open MemNEX', group: 'MemNEX', route: '/memnex', keywords: 'memory ram system' },
        { id: 'memnex.processes', title: 'Show running apps', group: 'MemNEX', route: '/memnex/processes', keywords: 'processes apps' },
        { id: 'memnex.high', title: 'Show high-memory apps', group: 'MemNEX', route: '/memnex/processes?filter=high', keywords: 'memory ram heavy' },
        { id: 'memnex.cleanup', title: 'Smart Cleanup', group: 'MemNEX', route: '/memnex/cleanup', keywords: 'free memory idle close' },
        { id: 'memnex.settings', title: 'MemNEX settings', group: 'MemNEX', route: '/memnex/settings', keywords: 'protected apps' },
      ];
    },
  };
}
