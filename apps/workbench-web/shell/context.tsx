'use client';
import { createContext, useContext } from 'react';
import type { ActivityEvent, AttentionItem, ContinueWorkingItem, ModuleStatus, WorkspaceState } from '@nex/shared';
import type { Theme } from '@nex/ui';

/** Mirrors GET /api/workbench/summary (apps/workbench-api/src/workbench/workbench.service.ts). */
export type WorkbenchSummary = {
  state: WorkspaceState;
  statusText: string;
  modules: ModuleStatus[];
  attention: AttentionItem[];
  continueWorking: ContinueWorkingItem[];
  activity: ActivityEvent[];
  preferences: { disabledModules: string[]; refresh: 'normal' | 'relaxed' };
  platform: string;
  version: string;
  updatedAt: string;
};

export type Badges = Record<string, number | undefined>;

export type WorkbenchContext = {
  summary: WorkbenchSummary | null;
  /** The Workbench API did not answer the last poll. */
  offline: boolean;
  refreshSummary: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  openPalette: () => void;
  /** Polling interval adjusted for the "Relaxed" refresh preference. */
  every: (ms: number) => number;
  /** A module publishes the badges of its own sections (e.g. memnex: { cleanup: 3 }). */
  setBadges: (moduleId: string, badges: Badges) => void;
  isEnabled: (moduleId: string) => boolean;
};

export const Ctx = createContext<WorkbenchContext | null>(null);

export function useWorkbench(): WorkbenchContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useWorkbench must be used inside <WorkbenchShell>');
  return c;
}
