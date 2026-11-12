import type { AttentionItem, ModuleStatus, NexCommand, NexModule } from '@nex/shared';
import type { FilenexEngine } from './engine';

const fmtN = (n: number) => n.toLocaleString('en-US');
const fmtGB = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** FileNEX as a Workbench module. Duplicates are informational, never Attention; storage only when it matters. */
export function createFilenexModule(engine: FilenexEngine): NexModule {
  return {
    id: 'filenex', name: 'FileNEX', route: '/filenex', description: 'Local File & Storage Intelligence',

    async getStatus(): Promise<ModuleStatus> {
      const s = engine.status();
      const st = await engine.storage.summary().catch(() => null);
      const base = { id: 'filenex', name: 'FileNEX', tagline: 'Local File & Storage Intelligence', route: '/filenex' };
      const free = st?.freeBytes != null ? [{ label: 'Free space', value: fmtGB(st.freeBytes) }] : [];
      const diskState = st?.status === 'critical' ? 'critical' : st?.status === 'low' ? 'attention' : null;
      const diskHeadline = st?.status === 'critical' ? `Disk space is critically low — ${fmtGB(st.freeBytes!)} free.` : st?.status === 'low' ? `Disk space is low — ${fmtGB(st.freeBytes!)} free.` : null;
      if (!s.configured) return {
        ...base, state: diskState ?? 'not-configured', headline: diskHeadline ?? 'No folders are being indexed.',
        metrics: [...free, { label: 'Locations', value: '0' }, { label: 'Indexed', value: '0 files' }], detail: 'Choose the folders FileNEX may index',
      };
      const unavailable = s.locations.filter(l => l.state === 'unavailable').length;
      return {
        ...base, state: diskState ?? (unavailable ? 'attention' : 'healthy'),
        headline: diskHeadline ?? (s.paused ? 'Indexing paused — search still works on the existing index.'
          : s.state === 'scanning' ? 'Indexing…' : unavailable ? `${unavailable} indexed folder${unavailable > 1 ? 's are' : ' is'} unavailable.` : 'Index up to date.'),
        metrics: [
          ...free,
          ...(st?.recoveryBytes ? [{ label: 'Potential recovery', value: fmtGB(st.recoveryBytes) }] : []),
          { label: 'Indexed', value: `${fmtN(s.indexedFiles)} files` },
          { label: 'Status', value: s.paused ? 'Paused' : s.state === 'scanning' || s.state === 'updating' ? 'Indexing' : s.state === 'error' ? 'Error' : 'Idle' },
        ].slice(0, 4),
        detail: 'Metadata only · stays on this computer',
      };
    },

    async getAttentionItems(): Promise<AttentionItem[]> {
      const s = engine.status();
      const t = new Date().toISOString();
      const storage = await engine.storage.attention().catch(() => []);
      return [...storage, ...s.locations.filter(l => l.state === 'unavailable' || l.state === 'error').map(l => ({
        id: `filenex:location:${l.id}`, sourceModule: 'FileNEX', severity: 'warning' as const,
        title: l.state === 'unavailable' ? `Indexed folder “${l.label}” unavailable` : `Indexing “${l.label}” failed`,
        description: l.state === 'unavailable' ? `${l.path} can’t be found — moved, renamed, or a drive is disconnected. Its existing index is still searchable.` : l.error ?? 'The folder could not be scanned.',
        action: '/filenex/settings', actionLabel: 'Review', timestamp: t,
      }))];
    },

    async getCommands(): Promise<NexCommand[]> {
      const base: NexCommand[] = [
        { id: 'filenex.open', title: 'Open FileNEX', group: 'FileNEX', route: '/filenex', keywords: 'files documents search' },
        { id: 'filenex.find', title: 'Find file', group: 'FileNEX', route: '/filenex/search', keywords: 'search files documents' },
        { id: 'filenex.duplicates', title: 'Show possible duplicates', group: 'FileNEX', route: '/filenex/duplicates', keywords: 'duplicate copies' },
        { id: 'filenex.versions', title: 'Show file versions', group: 'FileNEX', route: '/filenex/versions', keywords: 'latest final v2' },
        { id: 'filenex.folders', title: 'Choose folders FileNEX may index', group: 'FileNEX', route: '/filenex/settings?add=1', keywords: 'locations allowlist privacy' },
        { id: 'filenex.storage', title: 'Show storage', group: 'FileNEX', route: '/filenex/storage', keywords: 'disk space free full storage' },
        { id: 'filenex.large', title: 'Show large files', group: 'FileNEX', route: '/filenex/storage/large-files', keywords: 'big files disk space' },
        { id: 'filenex.dev-storage', title: 'Show developer storage', group: 'FileNEX', route: '/filenex/storage/developer', keywords: 'node_modules repos repositories disk space build cache' },
        { id: 'filenex.cleanup', title: 'Review storage cleanup', group: 'FileNEX', route: '/filenex/storage/cleanup', keywords: 'free up space recover disk' },
        { id: 'filenex.growth', title: 'What grew? (storage growth)', group: 'FileNEX', route: '/filenex/storage/growth', keywords: 'disk growth forecast' },
      ];
      const work = await engine.recentWork(7).catch(() => []);
      const active = work.find(w => w.isActive);
      if (active) base.push({ id: 'filenex.current', title: 'Show files from current context', group: 'FileNEX', route: `/filenex/collections/context:${active.id}`, keywords: active.title });
      return [...base, ...work.slice(0, 5).map(w => ({ id: `filenex.work.${w.id}`, title: `Find recent ${w.title} files`, group: 'FileNEX', route: `/filenex/collections/context:${w.id}`, keywords: 'recent work files' }))];
    },
  };
}
