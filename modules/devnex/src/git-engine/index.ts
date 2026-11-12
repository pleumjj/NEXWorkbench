import { exec } from '@nex/platform-core';
import type { GitInfo } from '../types';

/** Parse `git status --porcelain=v1 -b`. */
export function parseGitStatus(out: string): Pick<GitInfo, 'branch' | 'ahead' | 'behind' | 'changed' | 'untracked' | 'upstream'> {
  const lines = out.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  let branch: string | null = null, upstream: string | null = null, ahead = 0, behind = 0;
  if (head.startsWith('No commits yet on ')) branch = head.slice('No commits yet on '.length);
  else if (head.startsWith('HEAD (no branch)')) branch = 'detached HEAD';
  else if (head) {
    const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
    branch = m?.[1] ?? head;
    upstream = m?.[2] ?? null;
    const counts = m?.[3] ?? '';
    ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0);
    behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0);
  }
  const untracked = lines.filter(l => l.startsWith('??')).length;
  return { branch, upstream, ahead, behind, untracked, changed: lines.length - untracked };
}

/** Read-only Git context. No fetch/pull/push/commit — v1 never changes a repository. */
export async function gitInfo(path: string): Promise<GitInfo> {
  const base: GitInfo = { available: true, isRepo: false, path, branch: null, ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: null };
  try {
    const { stdout } = await exec('git', ['-C', path, 'status', '--porcelain=v1', '-b', '--untracked-files=normal'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
    return { ...base, isRepo: true, ...parseGitStatus(stdout) };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ...base, available: false, detail: 'Git is not installed.' };
    return { ...base, detail: /not a git repository/i.test(String(e?.stderr)) ? 'Not a Git repository.' : 'Git status could not be read.' };
  }
}
