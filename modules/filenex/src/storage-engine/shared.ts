import { join } from 'node:path';
import type { SharedCache } from '../storage-types';

/**
 * Shared package-manager stores. They live outside your project folders, so FileNEX only measures them when you turn
 * on "Shared developer caches" — total size only, no file names. Shown separately; never added to repository totals.
 */
export function sharedCacheLocations(home: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): Omit<SharedCache, 'bytes' | 'measuredAt' | 'insideApprovedLocation'>[] {
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  if (platform === 'win32') return [
    { id: 'npm', label: 'npm cache', path: join(local, 'npm-cache', '_cacache'), clean: 'npm cache clean --force' },
    { id: 'pnpm', label: 'pnpm store', path: join(local, 'pnpm', 'store'), clean: 'pnpm store prune' },
    { id: 'yarn', label: 'Yarn cache', path: join(local, 'Yarn', 'Cache'), clean: 'yarn cache clean' },
  ];
  if (platform === 'darwin') return [
    { id: 'npm', label: 'npm cache', path: join(home, '.npm', '_cacache'), clean: 'npm cache clean --force' },
    { id: 'pnpm', label: 'pnpm store', path: join(home, 'Library', 'pnpm', 'store'), clean: 'pnpm store prune' },
    { id: 'yarn', label: 'Yarn cache', path: join(home, 'Library', 'Caches', 'Yarn'), clean: 'yarn cache clean' },
  ];
  return [
    { id: 'npm', label: 'npm cache', path: join(home, '.npm', '_cacache'), clean: 'npm cache clean --force' },
    { id: 'pnpm', label: 'pnpm store', path: join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'pnpm', 'store'), clean: 'pnpm store prune' },
    { id: 'yarn', label: 'Yarn cache', path: join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'yarn'), clean: 'yarn cache clean' },
  ];
}
