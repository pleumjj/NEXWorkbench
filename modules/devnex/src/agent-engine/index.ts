import { createHash } from 'node:crypto';
import { sep } from 'node:path';
import type { PortInfo, ProcessInfo } from '@nex/shared';
import { agentName, ancestorsOf, descendantsOf, detectAgent, maskCommand, type AgentToolId } from '@nex/process-core';

/**
 * AI Agent Monitor — which coding agents run, what they started, and what they left behind.
 * No AI: process names, the process tree, start times, working directories and listening ports.
 * Never reads prompts, transcripts or files. Nothing is ever stopped on its own.
 */

const MIN = 60_000, HOUR = 60 * MIN;
/** Tree CPU (% of one core) above this counts as "working". */
const BUSY_CPU = 3;
/** No work for this long → "waiting for you". */
export const IDLE_AFTER = 10 * MIN;
/** Two start times this close are the same process (ps etime has 1 s resolution). */
const SAME_START_MS = 2000;
const MAX_CHILDREN = 300;

export type AgentChildRecord = { pid: number; startedAt: number; name: string; command: string; how: 'tree' | 'inferred'; firstSeenAt: number };
export type AgentSessionRecord = {
  id: string; tool: AgentToolId; pid: number; startedAt: number; cwd: string | null; host: string | null;
  firstSeenAt: number; lastSeenAt: number; endedAt: number | null; lastBusyAt: number;
  children: AgentChildRecord[];
};

export type Snapshot = { now: number; processes: ProcessInfo[]; ports: PortInfo[]; cwds: Map<number, string> };

export type AgentProcess = {
  pid: number; startedAt: number; name: string; command: string; how: 'tree' | 'inferred';
  cpu: number; memoryBytes: number; ports: number[];
  /** Why NEX won't stop it (system process, NEX itself, a protected app), if so. */
  blocked: string | null;
};
export type AgentSession = {
  id: string; tool: AgentToolId; toolName: string; pid: number; startedAt: string; endedAt: string | null;
  state: 'working' | 'waiting' | 'ended';
  /** When the tree last used CPU (≈ the agent's last activity). */
  lastActiveAt: string;
  cwd: string | null; folder: string | null; projectId: string | null; projectName: string | null;
  /** Folder name when the session runs in a Git worktree (e.g. .claude/worktrees/agent-…). */
  worktree: string | null;
  host: string | null;
  cpu: number; memoryBytes: number; processCount: number;
  ports: { port: number; pid: number; name: string }[];
  /** Processes it started that listen on a port (dev servers…), while it runs. */
  servers: AgentProcess[];
  /** After it ended: processes it started that are still running (top-level ones; their children are included in the totals). */
  leftovers: AgentProcess[];
};
export type AgentFinding =
  | { kind: 'leftovers'; sessionId: string; title: string; detail: string; processes: number; memoryBytes: number; ports: number[] }
  | { kind: 'duplicate-servers'; projectId: string; title: string; detail: string; ports: number[] }
  | { kind: 'idle-heavy'; sessionId: string; title: string; detail: string; memoryBytes: number };
export type AgentOverview = {
  updatedAt: string;
  sessions: AgentSession[];
  findings: AgentFinding[];
  summary: { running: number; working: number; waiting: number; ended: number; leftoverProcesses: number; leftoverMemoryBytes: number; leftoverPorts: number[]; agentMemoryBytes: number };
};

export type ViewContext = {
  projects: { id: string; name: string; path: string }[];
  /** null = NEX may stop it after confirmation; otherwise the reason it never will. */
  blockedReason: (p: ProcessInfo) => string | null;
};

/** A drive or file-system root says nothing about a project (and must never claim processes by folder). */
const isRoot = (p: string | null | undefined) => !p || /^([\\/]|[A-Za-z]:\\?)$/.test(p);
const keyOf = (pid: number, startedAt: number) => `${pid}:${Math.round(startedAt / 1000)}`;
const sameStart = (a: number | undefined, b: number) => a != null && Math.abs(a - b) <= SAME_START_MS;
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const fmtGb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const fmtAgo = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / (24 * HOUR))} days`);

/** The app an agent runs inside (display only). */
export function hostOf(processes: ProcessInfo[], pid: number): string | null {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  for (const a of ancestorsOf(processes, pid)) {
    if (a === pid) continue;
    const c = byPid.get(a)?.command ?? '';
    if (/Visual Studio Code\.app|[\\/]Code Helper|Code\.exe/i.test(c)) return 'VS Code';
    if (/Cursor\.app|Cursor\.exe/i.test(c)) return 'Cursor';
    if (/Windsurf\.app/i.test(c)) return 'Windsurf';
    if (/JetBrains|IntelliJ|WebStorm|PyCharm/i.test(c)) return 'JetBrains';
    if (/Applications\/Claude\.app/.test(c)) return 'Claude app';
    if (/ChatGPT\.app|Codex\.app/.test(c)) return 'ChatGPT app';
    if (/Terminal\.app|iTerm|Warp\.app|Ghostty|kitty|alacritty|WezTerm|WindowsTerminal|tmux/i.test(c)) return 'Terminal';
  }
  return null;
}

/** Pure state machine: feed it snapshots, ask it for a view. Persistable (toJSON / constructor). */
export class AgentTracker {
  readonly sessions = new Map<string, AgentSessionRecord>();
  constructor(saved: AgentSessionRecord[] = []) {
    for (const s of saved) {
      if (!s?.id || !Array.isArray(s.children)) continue;
      // A session saved with a root folder may have claimed processes by folder by mistake: keep only its real tree.
      this.sessions.set(s.id, isRoot(s.cwd) ? { ...s, cwd: null, children: s.children.filter(c => c.how === 'tree') } : s);
    }
  }
  toJSON(): AgentSessionRecord[] { return [...this.sessions.values()]; }

  /** Top-level agent processes (an agent started by another agent belongs to that session). */
  static agents(processes: ProcessInfo[]) {
    const tools = new Map<number, AgentToolId>();
    for (const p of processes) { const t = detectAgent(p); if (t && p.startedAt != null) tools.set(p.pid, t); }
    return [...tools.entries()].filter(([pid]) => ![...ancestorsOf(processes, pid)].some(a => a !== pid && tools.has(a)))
      .map(([pid, tool]) => ({ proc: processes.find(p => p.pid === pid)!, tool }));
  }

  /** Processes worth a working-directory lookup: agents, and re-parented user processes that may be theirs. */
  static cwdCandidates(processes: ProcessInfo[], sessions: Iterable<AgentSessionRecord>, now: number): number[] {
    const agents = AgentTracker.agents(processes).map(a => a.proc.pid);
    const earliest = Math.min(...[...sessions].filter(s => !s.endedAt || now - s.endedAt < 24 * HOUR).map(s => s.startedAt), ...AgentTracker.agents(processes).map(a => a.proc.startedAt!));
    const orphans = processes.filter(p => (p.ppid === 1 || p.ppid == null) && p.pid > 1 && p.startedAt != null && p.startedAt >= earliest
      && !/\.app[\\/]/.test(p.command) && !detectAgent(p)).map(p => p.pid).slice(0, 400);
    return [...agents, ...orphans];
  }

  /** The record for this process, matched by pid and start time within ps's ±1 s jitter. */
  private recordOf(pid: number, startedAt: number) {
    return [...this.sessions.values()].find(r => r.pid === pid && sameStart(startedAt, r.startedAt));
  }

  observe(s: Snapshot) {
    const { now, processes } = s;
    const live = new Map(processes.map(p => [p.pid, p]));
    const seen = new Set<string>();
    // Merge duplicates (same pid, start times within the jitter): keep the one seen first.
    for (const r of [...this.sessions.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt)) {
      const dup = [...this.sessions.values()].find(o => o !== r && o.pid === r.pid && sameStart(o.startedAt, r.startedAt) && o.firstSeenAt >= r.firstSeenAt && this.sessions.has(r.id));
      if (dup) { for (const c of dup.children) if (!r.children.some(x => x.pid === c.pid && sameStart(x.startedAt, c.startedAt))) r.children.push(c); this.sessions.delete(dup.id); }
    }

    for (const { proc, tool } of AgentTracker.agents(processes)) {
      const existing = this.recordOf(proc.pid, proc.startedAt!);
      const id = existing?.id ?? createHash('sha1').update(keyOf(proc.pid, proc.startedAt!)).digest('hex').slice(0, 12);
      seen.add(id);
      const rec: AgentSessionRecord = existing ?? {
        id, tool, pid: proc.pid, startedAt: proc.startedAt!, cwd: null, host: null, firstSeenAt: now, lastSeenAt: now, endedAt: null, lastBusyAt: now, children: [],
      };
      rec.lastSeenAt = now; rec.endedAt = null;
      const cwd = s.cwds.get(proc.pid);
      // An app-server running from / (or a drive root) says nothing about the project.
      if (!isRoot(cwd)) rec.cwd = cwd!;
      rec.host ??= hostOf(processes, proc.pid);
      const tree = [...descendantsOf(processes, proc.pid)].map(pid => live.get(pid)!).filter(Boolean);
      const cpu = proc.cpu + tree.reduce((n, p) => n + p.cpu, 0);
      if (cpu >= BUSY_CPU) rec.lastBusyAt = now;
      for (const p of tree) {
        if (p.startedAt == null || rec.children.length >= MAX_CHILDREN || rec.children.some(c => c.pid === p.pid && sameStart(p.startedAt, c.startedAt))) continue;
        rec.children.push({ pid: p.pid, startedAt: p.startedAt, name: p.name, command: maskCommand(p.command), how: 'tree', firstSeenAt: now });
      }
      this.sessions.set(id, rec);
    }
    // Agents that are gone (or whose pid now belongs to another process) have ended.
    for (const rec of this.sessions.values()) {
      if (seen.has(rec.id) || rec.endedAt) continue;
      const p = live.get(rec.pid);
      if (!p || !sameStart(p.startedAt, rec.startedAt)) rec.endedAt = now;
    }

    // Re-parented processes (`npm run dev &` from an agent's shell): matched by working directory and start time.
    const all = [...this.sessions.values()].flatMap(r => r.children);
    const isClaimed = (p: ProcessInfo) => all.some(c => c.pid === p.pid && sameStart(p.startedAt, c.startedAt));
    const agentPids = new Set(AgentTracker.agents(processes).map(a => a.proc.pid));
    for (const p of processes) {
      if (!(p.ppid === 1 || p.ppid == null) || p.startedAt == null || agentPids.has(p.pid) || /\.app[\\/]/.test(p.command)) continue;
      if (isClaimed(p)) continue;
      const cwd = s.cwds.get(p.pid);
      if (!cwd) continue;
      const owner = [...this.sessions.values()]
        .filter(r => !isRoot(r.cwd) && inside(cwd, r.cwd!) && p.startedAt! >= r.startedAt && p.startedAt! <= (r.endedAt ?? now))
        .sort((a, b) => (b.cwd!.length - a.cwd!.length) || (b.startedAt - a.startedAt))[0];
      if (owner && owner.children.length < MAX_CHILDREN) {
        const c: AgentChildRecord = { pid: p.pid, startedAt: p.startedAt, name: p.name, command: maskCommand(p.command), how: 'inferred', firstSeenAt: now };
        owner.children.push(c); all.push(c);
      }
    }

    // Forget ended sessions once nothing of theirs runs (after an hour), and anything older than a day.
    for (const rec of [...this.sessions.values()]) {
      if (!rec.endedAt) continue;
      const anyAlive = rec.children.some(c => sameStart(live.get(c.pid)?.startedAt, c.startedAt));
      if ((!anyAlive && now - rec.endedAt > HOUR) || now - rec.endedAt > 24 * HOUR) this.sessions.delete(rec.id);
    }
  }

  view(s: Snapshot, ctx: ViewContext): AgentOverview {
    const { now, processes } = s;
    const live = new Map(processes.map(p => [p.pid, p]));
    const portsOf = new Map<number, number[]>();
    for (const port of s.ports) if (port.pid) portsOf.set(port.pid, [...new Set([...(portsOf.get(port.pid) ?? []), port.port])].sort((a, b) => a - b));
    const projectOf = (cwd: string | null) => (cwd ? ctx.projects.filter(p => inside(cwd, p.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null : null);
    const treeTotals = (pids: Set<number>) => {
      let cpu = 0, mem = 0;
      for (const pid of pids) { const p = live.get(pid); if (p) { cpu += p.cpu; mem += p.memory; } }
      return { cpu, mem };
    };
    const asProcess = (p: ProcessInfo, how: 'tree' | 'inferred', withTree: boolean): AgentProcess => {
      const pids = withTree ? new Set([p.pid, ...descendantsOf(processes, p.pid)]) : new Set([p.pid]);
      const t = treeTotals(pids);
      return {
        pid: p.pid, startedAt: p.startedAt!, name: p.name, command: maskCommand(p.command), how, cpu: t.cpu, memoryBytes: t.mem,
        ports: [...new Set([...pids].flatMap(x => portsOf.get(x) ?? []))].sort((a, b) => a - b), blocked: ctx.blockedReason(p),
      };
    };

    const sessions: AgentSession[] = [...this.sessions.values()].map((rec): AgentSession => {
      const aliveChildren = rec.children.filter(c => sameStart(live.get(c.pid)?.startedAt, c.startedAt));
      const childPids = new Set(aliveChildren.map(c => c.pid));
      const how = new Map(aliveChildren.map(c => [c.pid, c.how]));
      const ended = !!rec.endedAt;
      const all = ended ? childPids : new Set([rec.pid, ...descendantsOf(processes, rec.pid), ...childPids]);
      const totals = treeTotals(all);
      const ports = [...all].flatMap(pid => (portsOf.get(pid) ?? []).map(port => ({ port, pid, name: live.get(pid)?.name ?? '' }))).sort((a, b) => a.port - b.port);
      // Top-level processes only: a process whose parent is also in the set is part of that one.
      const roots = [...childPids].filter(pid => !childPids.has(live.get(pid)?.ppid ?? -1)).map(pid => live.get(pid)!);
      const project = projectOf(rec.cwd);
      const servers = ended ? [] : roots.map(p => asProcess(p, how.get(p.pid) ?? 'tree', true)).filter(p => p.ports.length);
      const leftovers = ended ? roots.map(p => asProcess(p, how.get(p.pid) ?? 'tree', true)).sort((a, b) => b.memoryBytes - a.memoryBytes) : [];
      return {
        id: rec.id, tool: rec.tool, toolName: agentName(rec.tool), pid: rec.pid, startedAt: new Date(rec.startedAt).toISOString(), endedAt: rec.endedAt ? new Date(rec.endedAt).toISOString() : null,
        state: ended ? 'ended' : now - rec.lastBusyAt < IDLE_AFTER ? 'working' : 'waiting',
        lastActiveAt: new Date(rec.lastBusyAt).toISOString(),
        cwd: isRoot(rec.cwd) ? null : rec.cwd, folder: isRoot(rec.cwd) ? null : rec.cwd!.split(/[\\/]/).filter(Boolean).pop() ?? null,
        projectId: project?.id ?? null, projectName: project?.name ?? null,
        worktree: rec.cwd?.match(/[\\/]worktrees[\\/]([^\\/]+)/)?.[1] ?? null,
        host: rec.host, cpu: totals.cpu, memoryBytes: totals.mem, processCount: all.size, ports, servers, leftovers,
      };
    })
      // Ended sessions are only interesting while something of theirs still runs.
      .filter(x => x.state !== 'ended' || x.leftovers.length)
      .sort((a, b) => (a.state === 'ended' ? 1 : 0) - (b.state === 'ended' ? 1 : 0) || b.startedAt.localeCompare(a.startedAt));

    const findings: AgentFinding[] = [];
    for (const x of sessions.filter(v => v.leftovers.length)) {
      const mem = x.leftovers.reduce((n, p) => n + p.memoryBytes, 0);
      const ports = [...new Set(x.leftovers.flatMap(p => p.ports))];
      findings.push({
        kind: 'leftovers', sessionId: x.id, processes: x.leftovers.length, memoryBytes: mem, ports,
        title: `${x.leftovers.length} process${x.leftovers.length > 1 ? 'es' : ''} left by ${x.toolName}${x.projectName ? ` · ${x.projectName}` : ''}`,
        detail: `The session ended ${fmtAgo(now - Date.parse(x.endedAt!))} ago. Still running: ${x.leftovers.slice(0, 3).map(p => p.name).join(', ')}${ports.length ? ` · port ${ports.join(', ')}` : ''} · ${fmtGb(mem)}.`,
      });
    }
    const byProject = new Map<string, { name: string; ports: number[]; pids: Set<number> }>();
    for (const x of sessions) for (const p of [...x.servers, ...x.leftovers]) {
      if (!x.projectId || !p.ports.length) continue;
      const g = byProject.get(x.projectId) ?? { name: x.projectName!, ports: [], pids: new Set() };
      g.ports.push(...p.ports); g.pids.add(p.pid);
      byProject.set(x.projectId, g);
    }
    for (const [projectId, g] of byProject) if (g.pids.size > 1) findings.push({
      kind: 'duplicate-servers', projectId, ports: [...new Set(g.ports)].sort((a, b) => a - b),
      title: `${g.name} runs ${g.pids.size} dev servers`, detail: `Started by agents on ports ${[...new Set(g.ports)].sort((a, b) => a - b).join(', ')}. You probably need only one.`,
    });
    for (const x of sessions.filter(v => v.state === 'waiting' && now - Date.parse(v.lastActiveAt) > 2 * HOUR && v.memoryBytes > 1024 ** 3)) findings.push({
      kind: 'idle-heavy', sessionId: x.id, memoryBytes: x.memoryBytes,
      title: `${x.toolName}${x.projectName ? ` · ${x.projectName}` : ''} has been waiting for ${fmtAgo(now - Date.parse(x.lastActiveAt))}`,
      detail: `It still holds ${fmtGb(x.memoryBytes)}. If you are done with it, close it in ${x.host ?? 'its window'}.`,
    });

    const live_ = sessions.filter(x => x.state !== 'ended');
    const left = sessions.flatMap(x => x.leftovers);
    return {
      updatedAt: new Date(now).toISOString(), sessions, findings,
      summary: {
        running: live_.length, working: live_.filter(x => x.state === 'working').length, waiting: live_.filter(x => x.state === 'waiting').length,
        ended: sessions.length - live_.length, leftoverProcesses: left.length, leftoverMemoryBytes: left.reduce((n, p) => n + p.memoryBytes, 0),
        leftoverPorts: [...new Set(left.flatMap(p => p.ports))].sort((a, b) => a - b), agentMemoryBytes: live_.reduce((n, x) => n + x.memoryBytes, 0),
      },
    };
  }

  /** Which agent session started this process (itself, its tree, or recorded lineage), if any. */
  sessionOf(p: ProcessInfo, processes: ProcessInfo[]): AgentSessionRecord | null {
    if (p.startedAt == null) return null;
    const anc = ancestorsOf(processes, p.pid);
    for (const rec of this.sessions.values()) {
      if (rec.pid === p.pid && sameStart(p.startedAt, rec.startedAt)) return rec;
      if (!rec.endedAt && anc.has(rec.pid)) return rec;
      if (rec.children.some(c => c.pid === p.pid && sameStart(p.startedAt, c.startedAt))) return rec;
    }
    return null;
  }

  /** The leftover processes of an ended session that may be stopped now (identity re-checked: pid + start time). */
  leftoverTargets(sessionId: string, pids: number[], s: Snapshot, ctx: ViewContext): { stop: ProcessInfo[]; refused: { pid: number; reason: string }[] } {
    const rec = this.sessions.get(sessionId);
    if (!rec) return { stop: [], refused: pids.map(pid => ({ pid, reason: 'This session is no longer tracked.' })) };
    if (!rec.endedAt) return { stop: [], refused: pids.map(pid => ({ pid, reason: 'The agent is still running — NEX never stops a running agent’s work.' })) };
    const v = this.view(s, ctx).sessions.find(x => x.id === sessionId);
    const live = new Map(s.processes.map(p => [p.pid, p]));
    const stop: ProcessInfo[] = [], refused: { pid: number; reason: string }[] = [];
    for (const pid of [...new Set(pids)]) {
      const l = v?.leftovers.find(p => p.pid === pid);
      const p = live.get(pid);
      if (!l || !p || !sameStart(p.startedAt, l.startedAt)) refused.push({ pid, reason: 'No longer a leftover of this session (already stopped, or the PID now belongs to another process).' });
      else if (l.blocked) refused.push({ pid, reason: l.blocked });
      else stop.push(p);
    }
    return { stop, refused };
  }
}
