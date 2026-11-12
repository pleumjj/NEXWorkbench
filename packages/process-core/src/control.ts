import type { AppTarget } from '@nex/shared';
import { isAlive, type AppControl } from '@nex/platform-core';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until none of the pids exist (true) or the timeout passes (false). */
export async function waitUntilGone(pids: number[], timeoutMs: number, alive: (pid: number) => boolean = isAlive) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!pids.some(alive)) return true;
    await sleep(250);
  }
  return !pids.some(alive);
}

export type ControlOutcome = { stillRunning: boolean };

/**
 * Graceful-first process control. It never escalates to force on its own:
 * a failed graceful quit is reported back so the user can decide.
 */
export class ProcessController {
  constructor(private readonly os: AppControl) {}

  /** Whole GUI application (menu → Quit). Waits for the main process to exit. */
  async quitApp(app: AppTarget, waitMs = 5000): Promise<ControlOutcome> {
    await this.os.quitApp(app);
    return { stillRunning: !(await waitUntilGone([app.mainPid], waitMs)) };
  }

  /** One non-GUI process (SIGTERM / taskkill). */
  async stopProcess(pid: number, waitMs = 5000): Promise<ControlOutcome> {
    await this.os.quitProcess(pid);
    return { stillRunning: !(await waitUntilGone([pid], waitMs)) };
  }

  /** Immediate termination. Callers must have explicit user confirmation. */
  async forceKill(pids: number[], waitMs = 2000): Promise<ControlOutcome> {
    await this.os.forceKill(pids);
    return { stillRunning: !(await waitUntilGone(pids, waitMs)) };
  }
}
