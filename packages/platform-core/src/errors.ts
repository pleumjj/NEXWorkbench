import type { ActionErrorCode } from '@nex/shared';

/** Thrown by adapters with a reason the user can act on (never "Something went wrong"). */
export class ActionError extends Error {
  constructor(public readonly code: ActionErrorCode, message: string) { super(message); }
}

/** Whether a pid still exists. EPERM means it exists but belongs to someone else. */
export const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
};

export function mapKillError(e: any): never {
  const msg = `${e?.code ?? ''} ${e?.message ?? ''} ${e?.stderr ?? ''}`;
  if (/EPERM|not permitted|Access is denied|denied/i.test(msg)) throw new ActionError('permission', 'Permission denied. The operating system blocked this action.');
  if (/ESRCH|No such process|not found/i.test(msg)) throw new ActionError('gone', 'Process no longer exists.');
  throw new ActionError('unsupported', `The operating system rejected the request (${String(e?.message ?? e).slice(0, 120)}).`);
}
