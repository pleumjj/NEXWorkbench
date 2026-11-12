import type { ChildProcess } from 'node:child_process';
import { RingBuffer } from '@nex/logger';
import type { ServiceControl } from '@nex/platform-core';
import type { LogLevel, LogLine } from '../types';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 4000;

export const levelOf = (text: string, stream: LogLine['stream']): LogLevel =>
  (/\b(error|fatal|exception|unhandled|failed|ECONNREFUSED|EADDRINUSE)\b/i.test(text) || /\berr!/i.test(text)) ? 'error'
    : /\b(warn|warning|deprecated)\b/i.test(text) ? 'warning'
    : stream === 'stderr' && /\S/.test(text) ? 'warning' : 'info';

type Run = { child: ChildProcess; pid: number; startedAt: string; exitCode: number | null; exited: boolean; stopRequested: boolean; logs: RingBuffer<LogLine>; seq: number };

/**
 * Starts and stops services DevNEX launched itself, and keeps a bounded log buffer per service.
 * Logs live in memory only (2000 lines/service) and disappear when DevNEX stops.
 */
export class ServiceRunner {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(serviceId: string, line: LogLine) => void>();
  private readonly exits = new Set<(serviceId: string, code: number | null, requested: boolean) => void>();

  constructor(private readonly os: ServiceControl) {}

  onLog(fn: (serviceId: string, line: LogLine) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onExit(fn: (serviceId: string, code: number | null, requested: boolean) => void) { this.exits.add(fn); return () => this.exits.delete(fn); }

  get(serviceId: string) { return this.runs.get(serviceId) ?? null; }
  isRunning(serviceId: string) { const r = this.runs.get(serviceId); return !!r && !r.exited; }

  private append(serviceId: string, run: Run, stream: LogLine['stream'], text: string) {
    for (const raw of text.split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, MAX_LINE_LENGTH);
      if (!clean.trim()) continue;
      const line: LogLine = { seq: ++run.seq, at: new Date().toISOString(), stream, level: stream === 'system' ? 'info' : levelOf(clean, stream), text: clean };
      run.logs.push(line);
      this.listeners.forEach(fn => fn(serviceId, line));
    }
  }

  start(serviceId: string, command: string, cwd: string): Run {
    if (this.isRunning(serviceId)) throw new Error('Service is already running.');
    const previous = this.runs.get(serviceId);
    const child = this.os.spawnService(command, cwd);
    if (!child.pid) throw new Error('The command could not be started.');
    const run: Run = { child, pid: child.pid, startedAt: new Date().toISOString(), exitCode: null, exited: false, stopRequested: false, logs: previous?.logs ?? new RingBuffer<LogLine>(MAX_LINES), seq: previous?.seq ?? 0 };
    this.runs.set(serviceId, run);
    this.append(serviceId, run, 'system', `$ ${command}   (in ${cwd})`);
    child.stdout?.setEncoding('utf8').on('data', (d: string) => this.append(serviceId, run, 'stdout', d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => this.append(serviceId, run, 'stderr', d));
    child.on('error', err => this.append(serviceId, run, 'system', `Failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      run.exited = true;
      run.exitCode = code;
      this.append(serviceId, run, 'system', run.stopRequested ? 'Stopped.' : `Exited with ${code != null ? `code ${code}` : `signal ${signal}`}.`);
      this.exits.forEach(fn => fn(serviceId, code, run.stopRequested));
    });
    return run;
  }

  async stop(serviceId: string) {
    const run = this.runs.get(serviceId);
    if (!run || run.exited) return;
    run.stopRequested = true;
    await this.os.stopTree(run.pid);
  }

  logs(serviceId: string): LogLine[] { return this.runs.get(serviceId)?.logs.toArray() ?? []; }
  clearLogs(serviceId: string) { this.runs.get(serviceId)?.logs.clear(); }

  /** Stop everything DevNEX started (on shutdown). */
  async stopAll() { await Promise.allSettled([...this.runs.keys()].map(id => this.stop(id))); }
}
