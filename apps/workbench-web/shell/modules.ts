import type { IconName } from '@nex/ui';

/**
 * The modules the shell knows how to route to. Adding a future NEX (FileNEX…) means one entry here,
 * one route folder under app/, and one module on the API side. Unimplemented modules are not listed.
 */
export type ModuleNav = {
  id: string;
  name: string;
  tagline: string;
  route: string;
  icon: IconName;
  group: 'TOOLS';
  sections: { slug: string; label: string; icon: IconName }[];
};

export const MODULES: ModuleNav[] = [
  {
    id: 'memnex', name: 'MemNEX', tagline: 'Local System Intelligence', route: '/memnex', icon: 'memory', group: 'TOOLS',
    sections: [
      { slug: '', label: 'Overview', icon: 'overview' },
      { slug: 'processes', label: 'Processes', icon: 'processes' },
      { slug: 'cleanup', label: 'Smart Cleanup', icon: 'cleanup' },
      { slug: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
  {
    id: 'devnex', name: 'DevNEX', tagline: 'Local Developer Control Center', route: '/devnex', icon: 'code', group: 'TOOLS',
    sections: [
      { slug: '', label: 'Overview', icon: 'overview' },
      { slug: 'projects', label: 'Projects', icon: 'folder' },
      { slug: 'services', label: 'Services', icon: 'services' },
      { slug: 'ports', label: 'Ports', icon: 'ports' },
      { slug: 'logs', label: 'Logs', icon: 'logs' },
      { slug: 'environment', label: 'Environment', icon: 'env' },
      { slug: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
  {
    id: 'worknex', name: 'WorkNEX', tagline: 'Work Continuity Intelligence', route: '/worknex', icon: 'history', group: 'TOOLS',
    sections: [
      { slug: '', label: 'Overview', icon: 'overview' },
      { slug: 'timeline', label: 'Timeline', icon: 'timeline' },
      { slug: 'timesheet', label: 'Timesheet', icon: 'insights' },
      { slug: 'contexts', label: 'Contexts', icon: 'layers' },
      { slug: 'saved', label: 'Saved', icon: 'bookmark' },
      { slug: 'insights', label: 'Insights', icon: 'insights' },
      { slug: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
  {
    id: 'filenex', name: 'FileNEX', tagline: 'Local File & Storage Intelligence', route: '/filenex', icon: 'file', group: 'TOOLS',
    sections: [
      { slug: '', label: 'Overview', icon: 'overview' },
      { slug: 'search', label: 'Search', icon: 'search' },
      { slug: 'storage', label: 'Storage', icon: 'disk' },
      { slug: 'collections', label: 'Collections', icon: 'layers' },
      { slug: 'versions', label: 'Versions', icon: 'history' },
      { slug: 'duplicates', label: 'Duplicates', icon: 'copy' },
      { slug: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

export const moduleFor = (pathname: string) => MODULES.find(m => pathname === m.route || pathname.startsWith(`${m.route}/`)) ?? null;

/** "/devnex/projects/abc" → ["projects", "abc"] */
export const sectionsOf = (pathname: string, route: string) => pathname.slice(route.length).split('/').filter(Boolean);
