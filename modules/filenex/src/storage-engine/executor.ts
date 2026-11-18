import { lstat, rm } from 'node:fs/promises';
import { exec } from '@nex/platform-core';
import type { IndexedLocation } from '../types';
import type { CleanupCandidate, ProjectActivity, WorktreeGit, WorktreeStorage } from '../storage-types';
import { approvedLocationFor, isInside } from '../privacy-engine';

/**
 * The only place in FileNEX that removes anything — and only items the user confirmed in a cleanup preview.
 * Every item is re-checked right before it is removed; any doubt means "skip and say why", never "remove anyway".
 */

/** What the preview saw, so a changed item is never removed on a stale confirmation. */
export type Seen = { id: string; path: string; method: CleanupCandidate['method']; isDir: boolean | null; size: number | null; mtimeMs: number | null };

export async function seenOf(c: CleanupCandidate): Promise<Seen> {
  if (c.method === 'command') return { id: c.id, path: c.path, method: c.method, isDir: null, size: null, mtimeMs: null };
  const st = await lstat(c.path).catch(() => null);
  return { id: c.id, path: c.path, method: c.method, isDir: st ? st.isDirectory() : null, size: st && !st.isDirectory() ? st.size : null, mtimeMs: st ? st.mtimeMs : null };
}

export type CheckContext = {
  locations: IndexedLocation[];
  projects: Pick<ProjectActivity, 'path' | 'runningServices'>[];
  worktrees: WorktreeStorage[];
};

/** null = OK to remove; otherwise the reason it is skipped. Pure checks first, then the file system. */
export async function checkBeforeRemoving(c: CleanupCandidate | undefined, seen: Seen, ctx: CheckContext): Promise<string | null> {
  if (!c) return 'No longer suggested — it changed or is already gone.';
  if (c.path !== seen.path || c.method !== seen.method) return 'It changed since the preview.';
  if (!c.removable || c.risk === 'PROTECTED' || c.method === 'none') return c.keepReason ?? 'FileNEX won’t remove this item.';
  if (c.method === 'command') return c.command?.length ? null : 'No cleanup command for this item.';

  // Path items: inside an active approved folder, never the folder itself, never a project root or a parent of one.
  const loc = approvedLocationFor(c.path, { locations: ctx.locations });
  if (!loc) return 'This folder is no longer approved in FileNEX.';
  if (ctx.locations.some(l => isInside(l.path, c.path))) return 'It is (or contains) an approved folder — FileNEX never removes those.';
  const isWorktree = c.method === 'git-worktree';
  if (ctx.projects.some(p => isInside(p.path, c.path) && !(isWorktree && p.path === c.path))) return 'It contains a project folder — FileNEX never removes projects.';
  if (c.method === 'delete') {
    const owner = ctx.projects.filter(p => isInside(c.path, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (owner && owner.runningServices > 0) return 'Its project has services running — stop them first.';
  }
  if (isWorktree) {
    const w = ctx.worktrees.find(x => x.path === c.path);
    if (!w) return 'It is no longer a Git worktree.';
    if (w.inUse) return 'The worktree is in use.';
  }

  const st = await lstat(c.path).catch(() => null);
  if (!st) return 'It is no longer there.';
  if (st.isSymbolicLink()) return 'It is a symbolic link — FileNEX never follows or removes links.';
  if (seen.isDir !== null && st.isDirectory() !== seen.isDir) return 'It changed since the preview.';
  if (seen.mtimeMs !== null && Math.abs(st.mtimeMs - seen.mtimeMs) > 1) return 'It changed since the preview — preview it again.';
  if (seen.size !== null && st.size !== seen.size) return 'It changed since the preview — preview it again.';
  return null;
}

export type Removers = {
  trash?: (path: string) => Promise<void>;
  worktreeGit: (path: string) => Promise<WorktreeGit | null>;
  run?: (cmd: string, args: string[]) => Promise<void>;
};

const defaultRun = async (cmd: string, args: string[]) => {
  // Fixed argv from FileNEX's own table; a shell is used only on Windows so npm.cmd / yarn.cmd resolve.
  await exec(cmd, args, { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' });
};

/** Remove one checked item. Throws with a readable message on failure. */
export async function removeItem(c: CleanupCandidate, r: Removers): Promise<string> {
  switch (c.method) {
    case 'delete':
      await rm(c.path, { recursive: true, force: false, maxRetries: 2, retryDelay: 200 });
      return c.regenerate ? `Deleted. Re-create with: ${c.regenerate}` : 'Deleted.';
    case 'trash':
      if (!r.trash) throw new Error('Moving to the Trash is not available on this system.');
      await r.trash(c.path);
      return 'Moved to the Trash.';
    case 'git-worktree': {
      // Fresh Git state (never cached): any uncommitted or untracked change means Git keeps it — and so do we.
      const g = await r.worktreeGit(c.path);
      if (!g) throw new Error('Could not read the worktree’s Git state.');
      if (g.uncommitted) throw new Error(`It now has ${g.uncommitted} uncommitted change${g.uncommitted > 1 ? 's' : ''} — kept.`);
      if (!g.mainPath) throw new Error('Could not find the main repository.');
      await (r.run ?? defaultRun)('git', ['-C', g.mainPath, 'worktree', 'remove', c.path]);
      return `Worktree removed. Branch ${g.branch ?? '(detached)'} and its commits are kept.`;
    }
    case 'command': {
      const [cmd, ...args] = c.command ?? [];
      if (!cmd) throw new Error('No cleanup command.');
      await (r.run ?? defaultRun)(cmd, args);
      return `Ran ${c.command!.join(' ')}.`;
    }
    default:
      throw new Error('FileNEX won’t remove this item.');
  }
}

/** A readable error from rm / git / docker. */
export const errorText = (e: unknown) => {
  const x = e as { code?: string; stderr?: string; message?: string };
  if (x?.code === 'EACCES' || x?.code === 'EPERM') return 'Permission denied — some files could not be removed.';
  if (x?.code === 'ENOENT' && /spawn/.test(x.message ?? '')) return 'The tool is not installed or not on PATH.';
  if (x?.code === 'EBUSY') return 'A file is in use — close the app using it and try again.';
  return String(x?.stderr || x?.message || e).trim().split('\n')[0].slice(0, 200);
};
