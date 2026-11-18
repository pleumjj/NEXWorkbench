'use client';
/* DevNEX › Agents — which AI coding agents run, what they started, and what they left behind (no AI, no prompts read). */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentFinding, AgentOverview, AgentProcess, AgentSession } from '@nex/devnex';
import { EmptyState, Icon, Modal, Pill, Segmented, Stat, createPost, fmtBytes, since, useNow } from '@nex/ui';
import { useWorkbench } from '../../shell/context';

const API = '/api/devnex';
const post = createPost('DevNEX');
type Toasty = { tone: 'ok' | 'error'; text: string };
type View = 'Office' | 'List';

const TOOL_COLOR: Record<string, string> = { 'claude-code': '#d97757', codex: '#10a37f', gemini: '#4285f4', aider: '#8b5cf6', 'cursor-agent': '#64748b', opencode: '#f59e0b', goose: '#0ea5e9', copilot: '#6e40c9' };
const colorOf = (tool: string) => TOOL_COLOR[tool] ?? '#64748b';
const STATE: Record<AgentSession['state'], { label: string; tone: string }> = {
  working: { label: 'Working', tone: 'ok' }, waiting: { label: 'Waiting for you', tone: 'warn' }, ended: { label: 'Ended', tone: 'muted' },
};
const duration = (fromIso: string, now: number) => {
  const m = Math.max(0, Math.round((now - Date.parse(fromIso)) / 60_000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.round(m / 1440)} days`;
};
const where = (s: AgentSession) => s.projectName ?? s.folder ?? (s.host ? `${s.host} · no project folder` : 'No project folder');

export function AgentsPage({ setToast }: { setToast: (t: Toasty) => void }) {
  const { every } = useWorkbench();
  const now = useNow(15_000);
  const [data, setData] = useState<AgentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => { try { return (localStorage.getItem('nex.agents.view') as View) || 'Office'; } catch { return 'Office'; } });
  const [selected, setSelected] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<AgentSession | null>(null);
  const load = useCallback(() => fetch(`${API}/agents`).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`); setData(j); setError(null); }).catch(e => setError((e as Error).message)), []);
  useEffect(() => { load(); const t = setInterval(load, every(5000)); return () => clearInterval(t); }, [load, every]);
  const choose = (v: View) => { setView(v); try { localStorage.setItem('nex.agents.view', v); } catch { /* per-viewer convenience */ } };

  if (error && !data) return <EmptyState title="Agent Monitor unavailable">{error}</EmptyState>;
  if (!data) return <EmptyState title="Looking for AI agents…" />;
  const s = data.summary;
  const sel = data.sessions.find(x => x.id === selected) ?? null;
  const openCleanup = (x: AgentSession) => setCleanup(x);

  return (
    <>
      <div className="bento" style={{ marginBottom: 12 }}>
        <Stat label="Agents running" value={String(s.running)} detail={s.running ? `${s.working} working · ${s.waiting} waiting for you` : 'No AI agent is running'} />
        <Stat label="Agent memory" value={s.running ? fmtBytes(s.agentMemoryBytes) : '—'} detail="Agents and everything they started" />
        <Stat label="Left behind" value={s.leftoverProcesses ? `${s.leftoverProcesses}` : '0'} detail={s.leftoverProcesses ? `${fmtBytes(s.leftoverMemoryBytes)}${s.leftoverPorts.length ? ` · port ${s.leftoverPorts.join(', ')}` : ''}` : 'Nothing left running by ended sessions'} warn={s.leftoverProcesses > 0} />
      </div>

      {data.findings.map(f => <FindingNotice key={`${f.kind}:${'sessionId' in f ? f.sessionId : f.projectId}`} f={f} sessions={data.sessions} onCleanup={openCleanup} onSelect={id => { setSelected(id); }} />)}

      <div className="toolbar">
        <Segmented options={['Office', 'List'] as const} value={view} onChange={choose} />
        <span className="fine" style={{ margin: 0 }}>Read from the process list, ports and working folders — NEX never reads prompts or files.</span>
      </div>

      {!data.sessions.length ? (
        <div className="table"><EmptyState title="No AI agents running">Claude Code, Codex, Gemini CLI, Aider, Cursor Agent and others appear here while they run — in a terminal, an editor or their app.</EmptyState></div>
      ) : view === 'Office' ? (
        <Office sessions={data.sessions} now={now} selected={selected} onSelect={id => setSelected(id === selected ? null : id)} />
      ) : (
        <SessionList sessions={data.sessions} now={now} onCleanup={openCleanup} />
      )}

      {view === 'Office' && sel && <SessionCard s={sel} now={now} onCleanup={openCleanup} onClose={() => setSelected(null)} />}

      {cleanup && <CleanupDialog session={cleanup} onClose={() => setCleanup(null)} onDone={(text, tone) => { setToast({ tone, text }); setCleanup(null); load(); }} />}
    </>
  );
}

function FindingNotice({ f, sessions, onCleanup, onSelect }: { f: AgentFinding; sessions: AgentSession[]; onCleanup: (s: AgentSession) => void; onSelect: (id: string) => void }) {
  const s = 'sessionId' in f ? sessions.find(x => x.id === f.sessionId) : undefined;
  return (
    <div className="notice" style={{ marginBottom: 10 }}>
      <Icon name={f.kind === 'leftovers' ? 'alert' : 'activity'} size={16} />
      <div style={{ flex: 1 }}><b>{f.title}</b>{f.detail}</div>
      {f.kind === 'leftovers' && s && <button className="btn btn-ink btn-sm" onClick={() => onCleanup(s)}>Clean up…</button>}
      {f.kind === 'idle-heavy' && s && <button className="btn btn-line btn-sm" onClick={() => onSelect(s.id)}>Show</button>}
      {f.kind === 'duplicate-servers' && <Link className="btn btn-line btn-sm" href={`/devnex/ports`}>Ports</Link>}
    </div>
  );
}

/* ───────────────────────── List ───────────────────────── */
function SessionList({ sessions, now, onCleanup }: { sessions: AgentSession[]; now: number; onCleanup: (s: AgentSession) => void }) {
  return (
    <div className="table st-scroll" role="table">
      <div className="tr th cols-agents" role="row"><span>Agent</span><span>State</span><span className="r">Memory</span><span className="r">CPU</span><span>Ports</span><span>Started</span><span /></div>
      {sessions.map(s => (
        <div className="tr cols-agents row-wrap" role="row" key={s.id}>
          <span className="cell-app" style={{ minWidth: 0 }}>
            <span className="ag-dot" style={{ background: colorOf(s.tool) }} />
            <span style={{ minWidth: 0 }}><b translate="no">{s.toolName} · {where(s)}</b>
              <small>{[s.host, s.worktree && `worktree ${s.worktree}`, `${s.processCount} process${s.processCount === 1 ? '' : 'es'}`].filter(Boolean).join(' · ')}</small>
              {s.cwd && <small className="mono st-path" title={s.cwd}>{s.cwd.replace(/^\/Users\/[^/]+/, '~')}</small>}</span>
          </span>
          <span><Pill tone={STATE[s.state].tone}>{STATE[s.state].label}</Pill>{s.state === 'waiting' && <small className="fine" style={{ display: 'block', margin: 0 }}>for {duration(s.lastActiveAt, now)}</small>}</span>
          <span className="num r"><b>{fmtBytes(s.state === 'ended' ? s.leftovers.reduce((n, p) => n + p.memoryBytes, 0) : s.memoryBytes)}</b></span>
          <span className="num r">{s.cpu.toFixed(s.cpu < 10 ? 1 : 0)}%</span>
          <span className="fine" style={{ margin: 0 }}>{s.ports.length ? s.ports.map(p => p.port).join(', ') : '—'}</span>
          <span className="fine" style={{ margin: 0 }}>{s.state === 'ended' ? `Ended ${since(s.endedAt!, now)}` : `${duration(s.startedAt, now)} ago`}</span>
          <span className="cell-actions">{s.state === 'ended' && s.leftovers.length > 0 && <button className="btn btn-ink btn-sm" onClick={() => onCleanup(s)}>Clean up…</button>}</span>
          {(s.servers.length > 0 || s.leftovers.length > 0) && (
            <ul className="ag-procs">{[...s.servers, ...s.leftovers].map(p => <ProcLine key={p.pid} p={p} />)}</ul>
          )}
        </div>
      ))}
    </div>
  );
}

function ProcLine({ p }: { p: AgentProcess }) {
  return (
    <li>
      <span className="mono" title={p.command}><b translate="no">{p.name}</b>{` · PID ${p.pid}${p.ports.length ? ` · port ${p.ports.join(', ')}` : ''}`}</span>
      <span className="num">{fmtBytes(p.memoryBytes)}</span>
      {p.how === 'inferred' && <Pill tone="system">Likely from this agent</Pill>}
      {p.blocked && <Pill tone="protected" lock>Protected</Pill>}
    </li>
  );
}

/* ───────────────────────── Office ───────────────────────── */
/** Isometric projection for the desk drawings: units → px. */
const U = 5.2, OX = 90, OY = 78;
const iso = (x: number, y: number, z: number) => [OX + (x - y) * 0.866 * U, OY + (x + y) * 0.5 * U - z * U] as const;
const pts = (...p: (readonly [number, number])[]) => p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
/** A box as three visible faces (top, left = +y side, right = +x side). */
function Box({ x, y, z, w, d, h, cls }: { x: number; y: number; z: number; w: number; d: number; h: number; cls: string }) {
  const top = pts(iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h));
  const left = pts(iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x, y + d, z + h));
  const right = pts(iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x + w, y, z + h));
  return <g className={cls}><polygon className="t" points={top} /><polygon className="l" points={left} /><polygon className="r" points={right} /></g>;
}

function Desk({ s, now, selected, onClick }: { s: AgentSession; now: number; selected: boolean; onClick: () => void }) {
  const color = colorOf(s.tool);
  const ended = s.state === 'ended', waiting = s.state === 'waiting';
  const ports = ended ? [...new Set(s.leftovers.flatMap(p => p.ports))] : s.ports.map(p => p.port);
  const mem = ended ? s.leftovers.reduce((n, p) => n + p.memoryBytes, 0) : s.memoryBytes;
  // Screen = the monitor's front face (x 2…12, y = 1.4, z 9…15): an affine map for its content.
  const [sx, sy] = iso(2.4, 1.4, 14.6);
  const screen = `matrix(${0.866 * U} ${0.5 * U} 0 ${U} ${sx.toFixed(1)} ${sy.toFixed(1)})`;
  const [hx, hy] = iso(7, waiting ? 13.2 : 12.2, waiting ? 11.4 : 12.2);
  const [bx, by] = iso(7, 12.2, 15.8);
  const label = `${s.toolName} · ${where(s)} · ${STATE[s.state].label}`;
  return (
    <button className={`ag-desk ag-${s.state} ${selected ? 'on' : ''}`} onClick={onClick} aria-label={label} title={label} aria-pressed={selected} style={{ '--agent': color } as React.CSSProperties}>
      <svg viewBox="0 0 180 150" role="img" aria-hidden="true">
        <polygon className="ag-tile" points={pts(iso(-2, -2, 0), iso(16, -2, 0), iso(16, 16, 0), iso(-2, 16, 0))} />
        {/* desk */}
        <Box x={0} y={0} z={0} w={0.8} d={0.8} h={7} cls="ag-wood" />
        <Box x={13.2} y={0} z={0} w={0.8} d={0.8} h={7} cls="ag-wood" />
        <Box x={0} y={7.2} z={0} w={0.8} d={0.8} h={7} cls="ag-wood" />
        <Box x={13.2} y={7.2} z={0} w={0.8} d={0.8} h={7} cls="ag-wood" />
        <Box x={0} y={0} z={7} w={14} d={8} h={0.8} cls="ag-wood" />
        {/* monitor + stand */}
        <Box x={6.4} y={0.6} z={7.8} w={1.2} d={0.6} h={1.4} cls="ag-metal" />
        <Box x={2} y={0.6} z={9} w={10} d={0.8} h={6} cls={`ag-monitor ${ended && ports.length ? 'alert' : ''}`} />
        <g transform={screen} className="ag-screen">
          {!ended && !waiting && [0, 1, 2, 3].map(i => <rect key={i} className={`ag-code c${i}`} x={0.6} y={1 + i * 1.15} width={[5.5, 3.6, 6.8, 2.6][i]} height={0.45} rx={0.2} />)}
          {waiting && <text className="ag-scr-text" x={0.6} y={3.2} fontSize={1.6}>…</text>}
          {ports.slice(0, 2).map((p, i) => (
            <g key={p}><rect className="ag-port" x={0.5 + i * 4.6} y={4.2} width={4.2} height={1.3} rx={0.3} /><text className="ag-port-text" x={0.75 + i * 4.6} y={5.15} fontSize={1}>:{p}</text></g>
          ))}
        </g>
        {/* keyboard */}
        <Box x={4} y={4.4} z={7.8} w={6} d={1.8} h={0.25} cls="ag-metal" />
        {/* stool */}
        <Box x={5.6} y={11} z={0} w={2.8} d={2.8} h={4.2} cls="ag-stool" />
        {/* person (or an empty seat) */}
        {!ended && (
          <g className="ag-person">
            <Box x={5.4} y={waiting ? 12.3 : 11.3} z={4.2} w={3.2} d={2} h={5.2} cls="ag-body" />
            <circle cx={hx} cy={hy} r={7.4} className="ag-head" />
            <path className="ag-hair" d={`M${hx - 7.6} ${hy + 1} A 7.6 7.6 0 0 1 ${hx + 7.6} ${hy + 1} Q ${hx} ${hy - 2} ${hx - 7.6} ${hy + 1} Z`} />
          </g>
        )}
        {waiting && <g className="ag-mug"><Box x={11} y={4.2} z={7.8} w={1.2} d={1.2} h={1.6} cls="ag-cup" /><path className="ag-steam" d={`M${iso(11.6, 4.8, 10)[0]} ${iso(11.6, 4.8, 10)[1]} q 2 -3 0 -6 q -2 -3 0 -6`} /></g>}
        {waiting && <g className="ag-bubble"><ellipse cx={bx + 16} cy={by - 8} rx={17} ry={9} /><text x={bx + 16} y={by - 5} textAnchor="middle" fontSize={9}>zZ</text></g>}
        {ended && ports.length > 0 && <g className="ag-tag"><rect x={iso(13, 0, 15)[0] - 2} y={iso(13, 0, 15)[1] - 6} width={30} height={13} rx={3} /><text x={iso(13, 0, 15)[0] + 13} y={iso(13, 0, 15)[1] + 3.5} textAnchor="middle" fontSize={8}>!</text></g>}
      </svg>
      <span className="ag-label">
        <b translate="no"><i className="ag-dot" style={{ background: color }} />{s.toolName}</b>
        <small>{ended ? `Left behind · ${fmtBytes(mem)}` : waiting ? `Waiting ${duration(s.lastActiveAt, now)}` : `Working · ${fmtBytes(mem)}`}</small>
        {ports.length > 0 && <small className="mono">port {ports.join(', ')}</small>}
      </span>
    </button>
  );
}

function Office({ sessions, now, selected, onSelect }: { sessions: AgentSession[]; now: number; selected: string | null; onSelect: (id: string) => void }) {
  // One pod per project (or folder); ended sessions with leftovers sit at their old desks.
  const pods = useMemo(() => {
    const m = new Map<string, AgentSession[]>();
    for (const s of sessions) m.set(where(s), [...(m.get(where(s)) ?? []), s]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [sessions]);
  return (
    <div className="ag-floor" role="list" aria-label="Agents office">
      {pods.map(([name, list]) => (
        <section className="ag-pod" key={name} role="listitem">
          <p className="ag-pod-name"><span translate="no">{name}</span> <small>· {list.length}</small></p>
          <div className="ag-desks">{list.map(s => <Desk key={s.id} s={s} now={now} selected={selected === s.id} onClick={() => onSelect(s.id)} />)}</div>
        </section>
      ))}
    </div>
  );
}

function SessionCard({ s, now, onCleanup, onClose }: { s: AgentSession; now: number; onCleanup: (s: AgentSession) => void; onClose: () => void }) {
  return (
    <article className="tile ag-card">
      <div className="tile-head">
        <div>
          <p className="eyebrow" style={{ margin: 0 }}>{s.host ?? 'Agent session'}</p>
          <h3 translate="no" style={{ margin: '2px 0 0' }}>{s.toolName} · {where(s)}</h3>
        </div>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Pill tone={STATE[s.state].tone}>{STATE[s.state].label}</Pill><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></span>
      </div>
      <dl className="kv">
        <dt>Folder</dt><dd className="mono" translate="no">{s.cwd ?? '—'}</dd>
        {s.worktree && <><dt>Worktree</dt><dd translate="no">{s.worktree}</dd></>}
        <dt>Started</dt><dd>{`${duration(s.startedAt, now)} ago · PID ${s.pid}`}</dd>
        <dt>{s.state === 'ended' ? 'Ended' : 'Last active'}</dt><dd>{since(s.state === 'ended' ? s.endedAt! : s.lastActiveAt, now)}</dd>
        <dt>Memory · CPU</dt><dd>{`${fmtBytes(s.state === 'ended' ? s.leftovers.reduce((n, p) => n + p.memoryBytes, 0) : s.memoryBytes)} · ${s.cpu.toFixed(1)}% · ${s.processCount} process${s.processCount === 1 ? '' : 'es'}`}</dd>
        <dt>Ports</dt><dd>{s.ports.length ? s.ports.map(p => `${p.port} (${p.name})`).join(', ') : '—'}</dd>
      </dl>
      {(s.servers.length > 0 || s.leftovers.length > 0) && <ul className="ag-procs">{[...s.servers, ...s.leftovers].map(p => <ProcLine key={p.pid} p={p} />)}</ul>}
      {s.state === 'ended' && s.leftovers.length > 0
        ? <div className="modal-actions" style={{ justifyContent: 'flex-start' }}><button className="btn btn-ink" onClick={() => onCleanup(s)}>Clean up this session…</button></div>
        : s.state !== 'ended' && <p className="fine">{`NEX never stops a running agent. Close it in ${s.host ?? 'its window'} when you’re done.`}</p>}
    </article>
  );
}

/* ───────────────────────── Clean up ───────────────────────── */
function CleanupDialog({ session, onClose, onDone }: { session: AgentSession; onClose: () => void; onDone: (text: string, tone: 'ok' | 'error') => void }) {
  const stoppable = session.leftovers.filter(p => !p.blocked);
  const [pick, setPick] = useState<Set<number>>(() => new Set(stoppable.map(p => p.pid)));
  const [busy, setBusy] = useState(false);
  const toggle = (pid: number) => setPick(s => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<{ stopped: { pid: number; name: string }[]; stillRunning: { pid: number; name: string }[]; refused: { pid: number; reason: string }[] }>(`${API}/agents/${session.id}/cleanup`, { confirmed: true, pids: [...pick] });
      const parts = [r.stopped.length ? `Stopped ${r.stopped.map(p => p.name).join(', ')}.` : '', r.stillRunning.length ? `Still running: ${r.stillRunning.map(p => `${p.name} (PID ${p.pid})`).join(', ')} — stop it from MemNEX or a terminal.` : '', ...r.refused.map(x => `PID ${x.pid}: ${x.reason}`)].filter(Boolean);
      onDone(parts.join(' ') || 'Nothing was stopped.', r.stillRunning.length || r.refused.length ? 'error' : 'ok');
    } catch (e) { onDone((e as Error).message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-wide">
        <p className="eyebrow">{`Clean up session · ${session.toolName}`}</p>
        <h2 className="h2">{`Stop what ${where(session)} left running?`}</h2>
        <p>{`The session ended ${since(session.endedAt!, Date.now())}.`} These processes were started by it and are still running. NEX sends each a normal stop request (like Ctrl+C) — it never force-kills, and checks each one again first.</p>
        <ul className="st-paths">{session.leftovers.map(p => (
          <li key={p.pid}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
              <input type="checkbox" checked={pick.has(p.pid)} disabled={!!p.blocked} onChange={() => toggle(p.pid)} />
              <span style={{ minWidth: 0 }}><b translate="no">{p.name}</b>{` · PID ${p.pid}${p.ports.length ? ` · port ${p.ports.join(', ')}` : ''}`}
                <span className="mono" style={{ display: 'block', overflowWrap: 'anywhere' }} title={p.command}>{p.command}</span>
                {p.blocked ? <small style={{ display: 'block' }}>{p.blocked}</small> : p.how === 'inferred' && <small style={{ display: 'block' }}>Matched by folder and start time — likely from this agent. Untick it if it’s yours.</small>}</span>
            </label>
            <span className="num">{fmtBytes(p.memoryBytes)}</span>
          </li>
        ))}</ul>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-ink" disabled={!pick.size || busy} onClick={go}>{busy ? 'Stopping…' : `Stop ${pick.size} process${pick.size === 1 ? '' : 'es'}`}</button>
        </div>
      </div>
    </Modal>
  );
}
