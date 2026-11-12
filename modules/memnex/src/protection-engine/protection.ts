import type { ProcessGroup } from '@nex/process-core';
import type { AppSummary, ProcessStatus } from '../types';
import { MemnexError } from '../errors';

/**
 * Decides what can never be controlled. Order matters: OS → NEX itself → the app NEX runs inside → user protection.
 * Closing the host app once killed MemNEX mid-cleanup ("Failed to fetch"), hence the host rule.
 */
export function protectionFor(
  g: ProcessGroup,
  ctx: { hostPids: Set<number>; isProtected: (name: string) => boolean },
): { status: ProcessStatus; reason: string } | null {
  if (g.kind === 'system') return { status: 'System Critical', reason: 'Part of the operating system.' };
  if (g.kind === 'self') return { status: 'System Critical', reason: 'NEX Workbench itself.' };
  if (g.kind === 'app' && g.pids.some(p => ctx.hostPids.has(p))) {
    return { status: 'System Critical', reason: 'MemNEX is running inside this app — closing it would stop MemNEX.' };
  }
  if (ctx.isProtected(g.name)) return { status: 'Protected', reason: 'Protected by your preference.' };
  return null;
}

/** The API is the enforcement point: the UI hiding a button is never the only guard (PRD §25). */
export function assertControllable(app: AppSummary | undefined): AppSummary {
  if (!app) throw new MemnexError('not_found', 'Process no longer exists.');
  if (app.status === 'System Critical') throw new MemnexError('forbidden', `System protected. ${app.name}: ${app.reasons[0] ?? 'part of the operating system'}`);
  if (app.status === 'Protected') throw new MemnexError('forbidden', `${app.name} is protected by your preference. Unprotect it first.`);
  return app;
}
