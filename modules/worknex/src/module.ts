import type { AttentionItem, ContinueWorkingItem, ModuleStatus, NexCommand, NexModule } from '@nex/shared';
import type { KnownProject, WorkContext } from './types';
import type { WorknexEngine } from './engine';
import { isMeaningful } from './context-engine';

const ago = (iso: string, now: number) => {
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const SAVED_STALE_DAYS = 7;
const SERVICES_LEFT_RUNNING_MIN = 60;

/** WorkNEX as a Workbench module. Conservative: switching contexts is normal work, never an "issue". */
export function createWorknexModule(engine: WorknexEngine, projects: () => Promise<KnownProject[]>, now: () => number = Date.now): NexModule & { getContinueWorkingItems(): Promise<ContinueWorkingItem[]> } {
  const toItem = (c: WorkContext, list: KnownProject[]): ContinueWorkingItem => {
    const p = c.projectId ? list.find(x => x.id === c.projectId) : undefined;
    return {
      id: c.id, title: c.title, subtitle: c.subtitle ?? (c.files[0]?.name || undefined), sourceModule: 'WorkNEX',
      lastActiveAt: c.lastActiveAt, isActive: c.isActive, branch: c.gitBranch ?? null, path: c.projectPath ?? null,
      services: p?.services.filter(s => s.running).map(s => ({ name: s.name, port: s.port })) ?? [],
      route: `/worknex/contexts/${c.id}?resume=1`,
    };
  };
  return {
    id: 'worknex', name: 'WorkNEX', route: '/worknex', description: 'Work Continuity Intelligence',

    async getStatus(): Promise<ModuleStatus> {
      const s = engine.status();
      const base = { id: 'worknex', name: 'WorkNEX', tagline: 'Work Continuity Intelligence', route: '/worknex' };
      // No tracked apps = nothing to do yet. Neutral, no pressure, no error.
      if (!s.trackedApps) return {
        ...base, state: 'not-configured', headline: 'No applications are being tracked.',
        metrics: [{ label: 'Tracked apps', value: '0' }, { label: 'Tracking', value: 'Not configured' }],
        detail: 'Choose the apps WorkNEX may remember',
      };
      return {
        ...base, state: 'healthy',
        headline: s.paused ? 'WorkNEX is paused — nothing is being recorded.'
          : s.activeContext ? `Working on ${s.activeContext.title}.`
          : s.detection === 'unavailable' ? 'Limited activity detection.' : 'No tracked application is active.',
        metrics: [
          { label: 'Active', value: s.paused ? 'Paused' : s.activeContext?.title ?? '—' },
          { label: 'Today', value: `${s.todayContexts} context${s.todayContexts === 1 ? '' : 's'}` },
          { label: 'Saved', value: String(s.savedContexts) },
          { label: 'Tracking', value: s.paused ? 'Paused' : `${s.trackedApps} app${s.trackedApps === 1 ? '' : 's'}` },
        ],
        detail: s.detection !== 'full' && !s.paused ? s.detectionDetail ?? undefined : 'Only apps you chose · stays on this computer',
      };
    },

    async getAttentionItems(): Promise<AttentionItem[]> {
      const items: AttentionItem[] = [];
      const t = new Date(now()).toISOString();
      const s = engine.status();
      if (!s.paused && s.trackedApps && s.detection === 'limited') items.push({
        id: 'worknex:limited', sourceModule: 'WorkNEX', severity: 'info', title: 'WorkNEX sees apps but not window titles',
        description: s.detectionDetail ?? 'Window titles are unavailable.', action: '/worknex/settings', actionLabel: 'Details', timestamp: t,
      });
      const stale = engine.saved().filter(x => now() - new Date(x.lastResumedAt ?? x.savedAt).getTime() > SAVED_STALE_DAYS * 86_400_000)[0];
      if (stale) items.push({
        id: `worknex:saved:${stale.id}`, sourceModule: 'WorkNEX', severity: 'info', title: `“${stale.label}” hasn’t been resumed for a while`,
        description: `Saved ${ago(stale.savedAt, now())}. Resume it, or delete the save point if the work is done.`, action: `/worknex/saved?resume=${stale.id}`, actionLabel: 'Review', timestamp: t,
      });
      const list = await projects().catch(() => []);
      const active = s.activeContext?.id;
      const left = engine.recent(20).filter(c => c.id !== active && c.type === 'development' && c.projectId && now() - new Date(c.lastActiveAt).getTime() > SERVICES_LEFT_RUNNING_MIN * 60_000)
        .map(c => ({ c, p: list.find(p => p.id === c.projectId) })).filter(x => x.p?.services.some(sv => sv.running))[0];
      if (left) items.push({
        id: `worknex:services:${left.c.id}`, sourceModule: 'WorkNEX', severity: 'info', title: `${left.c.title} services still running`,
        description: `You last worked on ${left.c.title} ${ago(left.c.lastActiveAt, now())}, and ${left.p!.services.filter(s => s.running).length} of its services are still running.`,
        action: `/devnex/projects/${left.c.projectId}`, actionLabel: 'Open in DevNEX', timestamp: t,
      });
      return items;
    },

    async getCommands(): Promise<NexCommand[]> {
      const s = engine.status();
      const base: NexCommand[] = [
        { id: 'worknex.apps', title: 'Choose apps WorkNEX may track', group: 'WorkNEX', route: '/worknex/settings?add=1', keywords: 'tracked applications privacy allowlist' },
        { id: 'worknex.open', title: 'Open WorkNEX', group: 'WorkNEX', route: '/worknex', keywords: 'work context continuity' },
        { id: 'worknex.where', title: 'Where was I?', group: 'WorkNEX', route: '/worknex?where=1', keywords: 'resume last context recent' },
        { id: 'worknex.save', title: 'Save current context', group: 'WorkNEX', route: '/worknex?save=1', keywords: 'checkpoint save point' },
        { id: 'worknex.timeline', title: 'Show today’s timeline', group: 'WorkNEX', route: '/worknex/timeline', keywords: 'today history' },
        s.paused
          ? { id: 'worknex.resume-tracking', title: 'Resume WorkNEX tracking', group: 'WorkNEX', route: '/worknex?tracking=on', keywords: 'privacy mode unpause' }
          : { id: 'worknex.pause', title: 'Pause WorkNEX', group: 'WorkNEX', route: '/worknex?tracking=off', keywords: 'privacy mode stop tracking' },
      ];
      const recent = engine.recent(6).map(c => ({ id: `worknex.resume.${c.id}`, title: `Resume ${c.title}`, group: 'Work contexts', route: `/worknex/contexts/${c.id}?resume=1`, keywords: `${c.type} ${c.subtitle ?? ''}` }));
      const saved = engine.saved().slice(0, 6).map(x => ({ id: `worknex.saved.${x.id}`, title: `Resume saved: ${x.label}`, group: 'Work contexts', route: `/worknex/saved?resume=${x.id}`, keywords: 'save point checkpoint' }));
      return [...base, ...recent, ...saved];
    },

    /** "Continue working" for Workbench Home: recent meaningful contexts, enriched with live DevNEX services. */
    async getContinueWorkingItems(): Promise<ContinueWorkingItem[]> {
      const list = await projects().catch(() => []);
      // Work worth resuming: meaningful contexts only (a few seconds in an app or a meeting is not "work to continue").
      return engine.recent(20).filter(c => isMeaningful(c) && c.type !== 'meeting').slice(0, 3).map(c => toItem(c, list));
    },
  };
}
