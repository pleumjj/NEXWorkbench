'use client';
/* DevNEX — Local Developer Control Center. Know what’s running. Fix what’s broken. */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Container, DevnexOverview, EnvReport, GitInfo, HealthIssue, LogLine, PortConflict, PortEntry, Project, RuntimeCheck, RuntimeTool, Service, ServiceStatus,
} from '@nex/devnex';
import {
  AppIcon, ConfirmDialog, EmptyState, FilterChips, Icon, Meter, Modal, Pill, SearchField, Segmented, Setting, Stat, Toast, Wordmark as UiWordmark,
  createPost, fmtBytes, gbNum, since, useNow, useToast,
} from '@nex/ui';
import { useWorkbench } from '../../shell/context';
import { PageHeader } from '../../shell/PageHeader';

/* ───────────────────────── Types & helpers ───────────────────────── */
type Page = 'Overview' | 'Projects' | 'Services' | 'Ports' | 'Logs' | 'Environment' | 'Settings';
type ProjectDetail = { project: Project; git: GitInfo; env: EnvReport; runtime: RuntimeCheck[]; containers: Container[]; issues: HealthIssue[]; ports: PortEntry[] };
type EnvData = { runtimes: RuntimeTool[]; projects: { id: string; name: string; env: EnvReport; runtime: RuntimeCheck[] }[]; docker: { available: boolean; detail: string | null; containers: Container[] }; updatedAt: string };
type Confirm =
  | { kind: 'stop-service'; service: Service; projectName: string }
  | { kind: 'restart-service'; service: Service; projectName: string }
  | { kind: 'stop-process'; pid: number; name: string; port?: number; context?: string }
  | { kind: 'stop-project'; project: Project }
  | { kind: 'restart-project'; project: Project }
  | { kind: 'conflict'; conflict: PortConflict; message: string };
type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

const API = '/api/devnex';
const post = createPost('DevNEX');
const get = async <T,>(path: string): Promise<T> => {
  const r = await fetch(`${API}${path}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`);
  return j as T;
};

const PAGES: Page[] = ['Overview', 'Projects', 'Services', 'Ports', 'Logs', 'Environment', 'Settings'];
const slugOf = (p: Page) => (p === 'Overview' ? '' : p.toLowerCase());
const STATUS_TONE: Record<ServiceStatus, string> = { RUNNING: 'ok', STARTING: 'warn', WARNING: 'warn', FAILED: 'bad', STOPPED: 'muted', UNKNOWN: 'system' };
const STATUS_LABEL: Record<ServiceStatus, string> = { RUNNING: 'Running', STARTING: 'Starting', WARNING: 'Warning', FAILED: 'Failed', STOPPED: 'Stopped', UNKNOWN: 'Unknown' };
const StatusPill = ({ status }: { status: ServiceStatus }) => <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
const pct = (cpu: number | null, cores: number) => (cpu == null ? '—' : `${Math.min(100, cpu / Math.max(1, cores)).toFixed(cpu / cores < 10 ? 1 : 0)}%`);
const fmtMem = (n: number | null) => (n == null ? '—' : fmtBytes(n));
const isUp = (s: Service) => s.status === 'RUNNING' || s.status === 'STARTING' || s.status === 'WARNING';
const BASIS: Record<Project['usage']['basis'], string> = {
  devnex: 'Processes DevNEX started', inferred: 'Matched by working directory — may be incomplete', mixed: 'Started by DevNEX + matched by working directory', none: 'Nothing running',
};
const selectStyle = { height: 34 } as const;

/* ───────────────────────── App ───────────────────────── */
export function DevnexApp() {
  const router = useRouter();
  const pathname = usePathname() || '/devnex';
  const params = useSearchParams();
  const [section, sub] = pathname.split('/').slice(2);
  const page: Page = PAGES.find(p => slugOf(p) === (section ?? '')) ?? 'Overview';
  const setPage = useCallback((p: Page) => router.push(slugOf(p) ? `/devnex/${slugOf(p)}` : '/devnex'), [router]);
  const { theme, setTheme, every, setBadges, isEnabled } = useWorkbench();

  const [data, setData] = useState<DevnexOverview | null>(null);
  const [ports, setPorts] = useState<{ ports: PortEntry[]; conflicts: PortConflict[] } | null>(null);
  const [envData, setEnvData] = useState<EnvData | null>(null);
  const [registry, setRegistry] = useState<{ roots: string[]; projects: string[]; hidden: string[] } | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [logService, setLogService] = useState<string | null>(null);
  const [toast, setToast] = useToast<{ tone: 'ok' | 'error'; text: string }>(t => (t.tone === 'error' ? 9000 : 5000));

  const refresh = useCallback(async () => {
    try {
      setData(await get<DevnexOverview>('/overview'));
      setOffline(false);
    } catch { setOffline(true); } finally { setLoading(false); }
  }, []);
  const loadPorts = useCallback(async () => { try { setPorts(await get('/ports')); } catch {} }, []);
  const loadEnv = useCallback(async () => { try { setEnvData(await get('/environment')); } catch {} }, []);
  const loadRegistry = useCallback(async () => { try { setRegistry(await get('/registry')); } catch {} }, []);

  // Full scans are heavier than system metrics: refresh every 5 s, plus live SSE events for service changes.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, every(5000));
    const es = new EventSource(`${API}/events?topics=devnex.service.*,devnex.port.conflict`);
    ['devnex.service.started', 'devnex.service.stopped', 'devnex.service.failed', 'devnex.port.conflict'].forEach(t => es.addEventListener(t, () => refresh()));
    return () => { clearInterval(t); es.close(); };
  }, [refresh, every]);
  useEffect(() => {
    if (page === 'Ports' || page === 'Overview') loadPorts();
    if (page === 'Environment') loadEnv();
    if (page === 'Settings') loadRegistry();
  }, [page, data?.updatedAt, loadPorts, loadEnv, loadRegistry]);
  useEffect(() => {
    setBadges('devnex', { overview: data?.counts.issues || undefined, ports: data?.counts.conflicts || undefined });
  }, [data?.counts.issues, data?.counts.conflicts, setBadges]);
  // Deep links (Home, Attention, command palette): ?project=id → detail page.
  useEffect(() => {
    const p = params.get('project');
    if (page === 'Projects' && p && !sub) router.replace(`/devnex/projects/${p}`);
  }, [params, page, sub, router]);

  const services = useMemo(() => (data?.projects ?? []).flatMap(p => p.services.map(s => ({ ...s, projectName: p.name, projectSelf: !!p.self }))), [data]);

  /* ── Actions (all explicit; nothing here ever runs on its own) ── */
  const act: Act = async (label, fn) => {
    setBusy(true);
    try {
      const r = (await fn()) as { stillRunning?: boolean; detail?: string; failed?: { name: string; reason: string }[] } | undefined;
      if (r?.failed?.length) setToast({ tone: 'error', text: r.failed.map(f => `${f.name}: ${f.reason}`).join(' ') });
      else setToast(r?.stillRunning ? { tone: 'error', text: r.detail ?? `${label}: still running.` } : { tone: 'ok', text: label });
    } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(false); setConfirm(null); refresh(); loadPorts(); }
  };
  /** Start validates ports first; a conflict opens the explanation instead of a toast. */
  const start = async (s: Service) => {
    setBusy(true);
    try {
      await post(`${API}/services/${encodeURIComponent(s.id)}/start`, {});
      setToast({ tone: 'ok', text: `Starting ${s.name}…` });
    } catch (e) {
      const message = (e as Error).message;
      const fresh = await get<{ conflicts: PortConflict[] }>('/ports').catch(() => null);
      const conflict = fresh?.conflicts.find(c => c.requestedBy.serviceId === s.id);
      if (conflict) setConfirm({ kind: 'conflict', conflict, message });
      else setToast({ tone: 'error', text: message });
    } finally { setBusy(false); refresh(); loadPorts(); }
  };
  const startProject = async (p: Project) => {
    setBusy(true);
    try {
      const r = await post<{ started: string[]; failed: { name: string; reason: string }[] }>(`${API}/projects/${p.id}/start`, {});
      setToast(r.failed.length ? { tone: 'error', text: r.failed.map(f => `${f.name}: ${f.reason}`).join(' ') } : { tone: 'ok', text: `Starting ${r.started.join(', ')}…` });
    } catch (e) {
      const message = (e as Error).message;
      const fresh = await get<{ conflicts: PortConflict[] }>('/ports').catch(() => null);
      const conflict = fresh?.conflicts.find(c => c.requestedBy.projectId === p.id);
      if (conflict) setConfirm({ kind: 'conflict', conflict, message }); else setToast({ tone: 'error', text: message });
    } finally { setBusy(false); refresh(); loadPorts(); }
  };
  const openLogs = (id: string) => { setLogService(id); setPage('Logs'); };
  const openFolder = (p: Project) => post(`${API}/projects/${p.id}/open-folder`, {}).catch(e => setToast({ tone: 'error', text: (e as Error).message }));
  const handlers = { onStart: start, onConfirm: setConfirm, onLogs: openLogs };

  if (!isEnabled('devnex')) return (
    <div className="boot boot-inline"><Wordmark /><h1>DevNEX is turned off.</h1><p>Turn it back on in <Link href="/settings">Workbench settings</Link>.</p></div>
  );
  if (loading) return <div className="boot boot-inline"><Wordmark /><p>Reading your development environment…</p></div>;
  if (!data) return (
    <div className="boot boot-inline">
      <Wordmark />
      <h1>DevNEX can’t reach its local service.</h1>
      <p>Run <code>npm run dev</code> in the NEXWorkbench folder, then this page reconnects on its own.</p>
    </div>
  );

  const detail = page === 'Projects' && sub ? data.projects.find(p => p.id === sub) ?? null : null;
  const crumbs = [{ label: 'DevNEX', href: '/devnex' }, { label: page, href: detail ? '/devnex/projects' : undefined }, ...(detail ? [{ label: detail.name }] : [])];

  return (
    <>
      <PageHeader crumbs={crumbs} title={detail ? detail.name : page} updatedAt={data.updatedAt} offline={offline} onRefresh={() => { refresh(); loadPorts(); }} />

      {page === 'Overview' && <Overview data={data} ports={ports} onConfirm={setConfirm} onLogs={openLogs} />}
      {page === 'Projects' && !sub && <Projects data={data} onChanged={() => { refresh(); loadRegistry(); }} setToast={setToast} focusAdd={params.get('add') === '1'} />}
      {page === 'Projects' && sub && (detail
        ? <ProjectPage project={detail} cores={data.system.cpu.cores} updatedAt={data.updatedAt} busy={busy} {...handlers}
            onStartProject={startProject} onOpenFolder={openFolder} />
        : <EmptyState title="Project not found">It may have been removed, or its dev server stopped. <Link href="/devnex/projects">All projects</Link></EmptyState>)}
      {page === 'Services' && <Services services={services} cores={data.system.cpu.cores} highlight={params.get('service')} {...handlers} />}
      {page === 'Ports' && <Ports data={ports} onConfirm={setConfirm} initialQuery={params.get('port') ?? ''} />}
      {page === 'Logs' && <Logs services={services} selected={logService ?? params.get('service')} onSelect={setLogService} />}
      {page === 'Environment' && <Environment data={envData} initialProject={params.get('project')} />}
      {page === 'Settings' && <SettingsPage theme={theme} setTheme={setTheme} registry={registry} runtimes={data.runtimes} docker={data.docker}
        onChanged={() => { loadRegistry(); refresh(); }} setToast={setToast} />}

      {confirm?.kind === 'stop-service' && (
        <ConfirmDialog eyebrow="Stop service" title={`Stop ${confirm.service.name}?`} confirmLabel="Stop" busyLabel="Stopping…" busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={() => act(`${confirm.service.name} stopped.`, () => post(`${API}/services/${encodeURIComponent(confirm.service.id)}/stop`, { confirmed: true }))}>
          <p>{confirm.service.managedBy === 'devnex'
            ? <>DevNEX sends a normal stop signal to {confirm.projectName} › {confirm.service.name} and its child processes.</>
            : <>{confirm.service.name} was started outside DevNEX (PID {confirm.service.pid}). DevNEX asks that process to stop normally — like Ctrl+C in its terminal.</>}</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'restart-service' && (
        <ConfirmDialog eyebrow="Restart service" title={`Restart ${confirm.service.name}?`} confirmLabel="Restart" busyLabel="Restarting…" busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={() => act(`${confirm.service.name} restarted.`, () => post(`${API}/services/${encodeURIComponent(confirm.service.id)}/restart`, { confirmed: true }))}>
          <p>DevNEX stops {confirm.projectName} › {confirm.service.name}, waits for it to exit, then runs <code>{confirm.service.command}</code> again.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'stop-process' && (
        <ConfirmDialog eyebrow={confirm.port ? `Port ${confirm.port}` : 'Stop process'} title={`Stop ${confirm.name} (PID ${confirm.pid})?`} confirmLabel="Stop process" busyLabel="Stopping…" busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={() => act(`${confirm.name} stopped.`, () => post(`${API}/processes/${confirm.pid}/stop`, { confirmed: true, name: confirm.name }))}>
          <p>{confirm.context ? `${confirm.context} ` : ''}DevNEX sends a normal stop request. It never force-kills; if the process ignores it, stop it from its own terminal.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'stop-project' && (
        <ConfirmDialog eyebrow="Stop project" title={`Stop ${confirm.project.name}?`} confirmLabel="Stop all" busyLabel="Stopping…" busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={() => act(`${confirm.project.name} stopped.`, () => post(`${API}/projects/${confirm.project.id}/stop`, { confirmed: true }))}>
          <p>DevNEX sends a normal stop request to each running service:</p>
          <ul className="confirm-list">{confirm.project.services.filter(s => isUp(s) && s.source !== 'docker-compose').map(s => (
            <li key={s.id}><span>{s.name}{s.port ? ` :${s.port}` : ''}</span><span className="fine" style={{ margin: 0 }}>{s.managedBy === 'devnex' ? 'started by DevNEX' : `PID ${s.pid}, started elsewhere`}</span></li>
          ))}</ul>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'restart-project' && (
        <ConfirmDialog eyebrow="Restart project" title={`Restart ${confirm.project.name}?`} confirmLabel="Restart" busyLabel="Restarting…" busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={() => act(`${confirm.project.name} restarted.`, () => post(`${API}/projects/${confirm.project.id}/restart`, { confirmed: true }))}>
          <p>DevNEX stops the running services, waits for them to exit, checks every port again, then starts the project’s services. If a port is taken, nothing is started.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === 'conflict' && (
        <Modal onClose={() => setConfirm(null)}>
          <p className="eyebrow tone-text-critical">Port conflict</p>
          <h2 className="h2">Cannot start {confirm.conflict.requestedBy.serviceName}.</h2>
          <p>Port {confirm.conflict.port} is already in use. Nothing was stopped.</p>
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Current owner</dt><dd>{confirm.conflict.usedBy.processName ?? 'unknown process'}</dd>
            <dt>PID</dt><dd>{confirm.conflict.usedBy.pid ?? 'hidden by the OS'}</dd>
            <dt>Associated project</dt><dd>{confirm.conflict.usedBy.projectName ?? 'not tied to a known project'}</dd>
            <dt>Requested by</dt><dd>{confirm.conflict.requestedBy.projectName} / {confirm.conflict.requestedBy.serviceName}</dd>
          </dl>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel start</button>
            <button className="btn btn-line" onClick={() => { const port = confirm.conflict.port; setConfirm(null); router.push(`/devnex/ports?port=${port}`); }}>View process</button>
            {confirm.conflict.usedBy.pid && (
              <button className="btn btn-ink" onClick={() => setConfirm({ kind: 'stop-process', pid: confirm.conflict.usedBy.pid!, name: confirm.conflict.usedBy.processName ?? 'process', port: confirm.conflict.port, context: `${confirm.conflict.requestedBy.projectName} › ${confirm.conflict.requestedBy.serviceName} needs port ${confirm.conflict.port}.` })}>Stop process…</button>
            )}
          </div>
        </Modal>
      )}
      {toast && <Toast tone={toast.tone} text={toast.text} />}
    </>
  );
}

function Wordmark() {
  return <UiWordmark top="DEV" bottom="NEX" sub={['Developer', 'Control Center']} label="DevNEX" variant="ink" />;
}

/* ───────────────────────── Overview ───────────────────────── */
function Overview({ data, ports, onConfirm, onLogs }: { data: DevnexOverview; ports: { conflicts: PortConflict[] } | null; onConfirm: (c: Confirm) => void; onLogs: (id: string) => void }) {
  const now = useNow();
  const critical = data.issues.filter(i => i.severity === 'critical');
  const warnings = data.issues.filter(i => i.severity === 'warning');
  const tone = critical.length ? 'critical' : warnings.length ? 'moderate' : 'healthy';
  const headline = critical.length ? `${critical.length} problem${critical.length > 1 ? 's' : ''} ${critical.length > 1 ? 'are' : 'is'} breaking your setup.`
    : warnings.length ? `${warnings.length} thing${warnings.length > 1 ? 's' : ''} worth a look.` : 'Everything you’re running looks healthy.';
  const top = (critical[0] ?? warnings[0]) as HealthIssue | undefined;
  const conflict = ports?.conflicts[0];
  const active = data.projects.filter(p => p.services.some(isUp));
  const runningProjects = active.length;
  return (
    <>
      <div className="bento">
        <article className={`tile tile-health tone-${tone}`}>
          <p className="eyebrow">Development status · diagnosis</p>
          <h2 className="state-word">{critical.length ? 'Critical' : warnings.length ? 'Warning' : 'Healthy'}</h2>
          <p className="insight-headline">{headline}</p>
          {top && <p className="insight-detail">{top.description}</p>}
          <ul className="evidence" aria-label="Evidence">
            <li>{data.counts.running} of {data.counts.services} services running</li>
            <li>{data.counts.ports} listening ports{data.counts.unknownPorts ? ` · ${data.counts.unknownPorts} not tied to a project` : ''}</li>
            {!!data.counts.conflicts && <li>{data.counts.conflicts} port conflict{data.counts.conflicts > 1 ? 's' : ''}</li>}
            <li>Docker {data.docker.available ? `· ${data.docker.running} running` : 'not available'}</li>
          </ul>
          <div className="tile-foot">
            {conflict?.usedBy.pid ? (
              <button className="btn btn-ink" onClick={() => onConfirm({ kind: 'stop-process', pid: conflict.usedBy.pid!, name: conflict.usedBy.processName ?? 'process', port: conflict.port, context: `${conflict.requestedBy.projectName} › ${conflict.requestedBy.serviceName} needs port ${conflict.port}.` })}>
                Free port {conflict.port} <Icon name="arrow" size={16} />
              </button>
            ) : top ? <Link className="btn btn-ink" href={top.port ? `/devnex/ports?port=${top.port}` : top.projectId ? `/devnex/projects/${top.projectId}` : '/devnex/projects'}>Review <Icon name="arrow" size={16} /></Link>
              : <span className="no-action"><Icon name="check" size={16} />No action needed</span>}
          </div>
        </article>

        <article className="tile tile-memory">
          <p className="eyebrow">Memory in use</p>
          <p className="big-num">{gbNum(data.system.memory.used)}<span> / {gbNum(data.system.memory.total)} GB</span></p>
          <Meter value={data.system.memory.percent} tone={data.system.memory.percent >= 85 ? 'high' : data.system.memory.percent >= 70 ? 'moderate' : 'healthy'} label={`${data.system.memory.percent.toFixed(0)}% used`} />
          <dl className="signals">
            <div className="signal signal-ok"><dt>Dev processes</dt><dd><i />{fmtBytes(data.devProcesses.memory)}</dd></div>
            <div className={`signal ${data.docker.exited ? 'signal-warn' : 'signal-ok'}`}><dt>Containers</dt><dd><i />{data.docker.available ? `${data.docker.running} running` : 'Docker off'}</dd></div>
            <div className={`signal ${data.counts.issues ? 'signal-warn' : 'signal-ok'}`}><dt>Issues</dt><dd><i />{data.counts.issues}</dd></div>
          </dl>
        </article>

        <Stat label="Projects running" value={`${runningProjects}`} detail={`of ${data.counts.projects} known`} />
        <Stat label="Services running" value={`${data.counts.running}`} detail={data.counts.failed ? `${data.counts.failed} failed` : `of ${data.counts.services} known`} warn={!!data.counts.failed} />
        <Stat label="Ports in use" value={`${data.counts.ports}`} detail={`${data.counts.unknownPorts} unknown · ${data.counts.conflicts} conflicts`} warn={!!data.counts.conflicts} />

        <article className="tile tile-consumers">
          <div className="tile-head">
            <div><p className="eyebrow">Issues</p><h3>{data.issues.length ? 'What needs attention' : 'Nothing to fix'}</h3></div>
            <Link className="btn btn-ghost" href="/devnex/projects">Projects <Icon name="arrow" size={16} /></Link>
          </div>
          {data.issues.length ? data.issues.slice(0, 6).map(i => <IssueRow key={i.id} issue={i} />) : <EmptyState title="All clear">No port conflicts, crashed services, missing variables or runtime mismatches.</EmptyState>}
        </article>

        <article className="tile tile-system">
          <p className="eyebrow">Toolchain</p>
          <dl className="spec">
            {data.runtimes.map(r => <div key={r.name}><dt>{r.name}</dt><dd>{r.version ?? 'not installed'}</dd></div>)}
          </dl>
          <p className="fine">Checked {since(data.updatedAt, now)} · versions cached for 5 min</p>
        </article>
      </div>

      <section className="section">
        <p className="eyebrow">Active projects</p>
        <h3 className="section-title">{active.length ? 'Running now' : 'Nothing is running'}</h3>
        {active.length ? (
          <div className="bento">
            {active.map(p => <ProjectCard key={p.id} project={p} cores={data.system.cpu.cores} issues={data.issues.filter(i => i.projectId === p.id)} onConfirm={onConfirm} onLogs={onLogs} />)}
          </div>
        ) : <div className="table"><EmptyState title="No project is running">Start one from Projects, or run its dev server in a terminal — DevNEX detects it by its port.</EmptyState></div>}
      </section>
    </>
  );
}

function ProjectCard({ project: p, cores, issues, onConfirm, onLogs }: { project: Project; cores: number; issues: HealthIssue[]; onConfirm: (c: Confirm) => void; onLogs: (id: string) => void }) {
  const logged = p.services.find(s => s.hasLogs);
  return (
    <article className="tile span-6 module-card">
      <div className="tile-head">
        <div><h3>{p.name}</h3><p className="path" title={p.path}>{p.path}</p></div>
        <StatusPill status={p.status} />
      </div>
      <dl className="kv">
        {p.services.map(s => (
          <Fragment key={s.id}><dt>{s.name}{s.port ? ` :${s.port}` : ''}</dt><dd><span style={{ color: s.status === 'FAILED' ? 'var(--critical)' : undefined }}>{STATUS_LABEL[s.status]}</span></dd></Fragment>
        ))}
      </dl>
      <dl className="spec">
        <div><dt>CPU</dt><dd>{pct(p.usage.cpuPercent, cores)}</dd></div>
        <div><dt>RAM</dt><dd>{fmtBytes(p.usage.memoryBytes)}</dd></div>
        <div><dt>Processes</dt><dd>{p.usage.processCount}</dd></div>
        <div><dt>Attribution</dt><dd title={BASIS[p.usage.basis]} style={{ fontSize: 13 }}>{p.usage.basis === 'devnex' ? 'Exact' : p.usage.basis === 'none' ? '—' : 'Inferred'}</dd></div>
      </dl>
      {issues[0] && <p className="fine" style={{ margin: 0 }}><b>Issue:</b> {issues[0].description}</p>}
      <div className="tile-foot">
        <span className="cell-actions" style={{ justifyContent: 'flex-start' }}>
          {logged && <button className="btn btn-line" onClick={() => onLogs(logged.id)}><Icon name="logs" size={13} />Logs</button>}
          {!p.self && <button className="btn btn-line" onClick={() => onConfirm({ kind: 'stop-project', project: p })}><Icon name="stop" size={13} />Stop</button>}
          {p.self && <span className="fine" style={{ margin: 0 }}>This is NEX Workbench itself</span>}
        </span>
        <Link className="btn btn-ink" href={`/devnex/projects/${p.id}`}>Open <Icon name="arrow" size={16} /></Link>
      </div>
    </article>
  );
}

function IssueRow({ issue }: { issue: HealthIssue }) {
  return (
    <div className={`issue sev-${issue.severity}`}>
      <i aria-hidden />
      <div>
        <b>{issue.title}</b>
        <p>{issue.description}</p>
        <p className="why"><b style={{ display: 'inline' }}>Likely cause:</b> {issue.reason} <b style={{ display: 'inline' }}>Recommended:</b> {issue.recommendedAction}</p>
      </div>
      <Pill tone={issue.severity === 'critical' ? 'bad' : issue.severity === 'warning' ? 'warn' : 'muted'}>{issue.severity}</Pill>
    </div>
  );
}

/* ───────────────────────── Services (shared table) ───────────────────────── */
type Svc = Service & { projectName: string; projectSelf?: boolean };
type SvcHandlers = { onStart: (s: Service) => void; onConfirm: (c: Confirm) => void; onLogs: (id: string) => void };

function ServiceRows({ services, cores, onStart, onConfirm, onLogs, showProject = true, highlight, readOnly }: SvcHandlers & { services: Svc[]; cores: number; showProject?: boolean; highlight?: string | null; readOnly?: boolean }) {
  if (!services.length) return <EmptyState title="No services">Add a <code>devnex.config.json</code> or <code>dev</code> scripts to package.json.</EmptyState>;
  return (
    <>
      {services.map(s => {
        const running = isUp(s);
        return (
          <div className={`row-wrap ${highlight === s.id ? 'row-highlight' : ''}`} key={s.id}>
            <div className="tr cols-services">
              <span className="cell-app">
                <AppIcon kind={s.type === 'container' ? 'container' : 'terminal'} />
                <span><b>{s.name}</b><small>{showProject ? `${s.projectName} · ` : ''}{s.type}{s.command ? ` · ${s.command}` : ''}</small>{s.detail && <small className="about">{s.detail}</small>}</span>
              </span>
              <span><StatusPill status={s.status} /></span>
              <span className="num">{s.port ?? '—'}</span>
              <span className="num r">{pct(s.cpuPercent, cores)}</span>
              <span className="num">{fmtMem(s.memoryBytes)}{s.pid ? <small className="fine" style={{ display: 'block', margin: 0 }}>PID {s.pid}</small> : null}</span>
              {readOnly || s.projectSelf ? <span className="cell-actions"><span className="fine" style={{ margin: 0 }}>Read-only</span></span> : <span className="cell-actions">
                {s.hasLogs && <button className="btn btn-line" onClick={() => onLogs(s.id)}><Icon name="logs" size={13} />Logs</button>}
                {running && s.command && s.managedBy === 'devnex' && <button className="btn btn-line" onClick={() => onConfirm({ kind: 'restart-service', service: s, projectName: s.projectName })}>Restart</button>}
                {running ? <button className="btn btn-line" onClick={() => onConfirm({ kind: 'stop-service', service: s, projectName: s.projectName })}><Icon name="stop" size={13} />Stop</button>
                  : s.command ? <button className="btn btn-ink" onClick={() => onStart(s)}><Icon name="play" size={13} />Start</button> : null}
              </span>}
            </div>
          </div>
        );
      })}
    </>
  );
}

function Services({ services, cores, highlight, ...h }: SvcHandlers & { services: Svc[]; cores: number; highlight: string | null }) {
  const [filter, setFilter] = useState<'All' | 'Running' | 'Stopped' | 'Problems'>('All');
  const [query, setQuery] = useState('');
  const list = services.filter(s => (!query || `${s.name} ${s.projectName} ${s.command ?? ''} ${s.port ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    && (filter === 'All' || (filter === 'Running' ? s.status === 'RUNNING' : filter === 'Stopped' ? s.status === 'STOPPED' : ['FAILED', 'WARNING'].includes(s.status))));
  const counts = { All: services.length, Running: services.filter(s => s.status === 'RUNNING').length, Stopped: services.filter(s => s.status === 'STOPPED').length, Problems: services.filter(s => ['FAILED', 'WARNING'].includes(s.status)).length };
  return (
    <>
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Search services" />
        <FilterChips options={['All', 'Running', 'Stopped', 'Problems'] as const} value={filter} onChange={setFilter} counts={counts} />
      </div>
      <div className="table" role="table" aria-label="Services">
        <div className="tr th cols-services" role="row"><span>Service</span><span>Status</span><span>Port</span><span className="r">CPU</span><span>Memory</span><span /></div>
        <ServiceRows services={list} cores={cores} highlight={highlight} {...h} />
      </div>
      <p className="fine section-note" style={{ marginTop: 12 }}>Logs are available for services DevNEX starts. Services already running elsewhere show their process and port.</p>
    </>
  );
}

/* ───────────────────────── Projects ───────────────────────── */
function Projects({ data, onChanged, setToast, focusAdd }: {
  data: DevnexOverview; onChanged: () => void; setToast: (t: { tone: 'ok' | 'error'; text: string }) => void; focusAdd: boolean;
}) {
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusAdd) input.current?.focus(); }, [focusAdd]);
  const add = async () => {
    try { await post(`${API}/projects`, { path }); setPath(''); setToast({ tone: 'ok', text: 'Project added.' }); onChanged(); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
  };
  const list = data.projects.filter(p => !query || `${p.name} ${p.path}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <div className="toolbar add-row">
        <input ref={input} value={path} onChange={e => setPath(e.target.value)} placeholder="Add a project folder, e.g. ~/Documents/my-app" aria-label="Project folder" onKeyDown={e => e.key === 'Enter' && path && add()} />
        <button className="btn btn-ink" disabled={!path} onClick={add}><Icon name="plus" size={14} />Add project</button>
        {data.projects.length > 5 && <SearchField value={query} onChange={setQuery} placeholder="Search projects" />}
      </div>
      <div className="table" role="table" aria-label="Projects">
        <div className="tr th" role="row"><span>Project</span><span>Status</span><span className="r">Services</span><span>Path</span><span /></div>
        {list.length ? list.map(p => (
          <div className="row-wrap" key={p.id}>
            <div className="tr" role="row">
              <Link className="cell-app" href={`/devnex/projects/${p.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <span className="chev"><Icon name="chevron" size={14} /></span>
                <AppIcon kind="folder" />
                <span><b>{p.name}</b><small>{p.origin === 'detected' ? 'Detected from a running process' : 'Registered'}{p.packageManager ? ` · ${p.packageManager}` : ''}{p.signals.devnexConfig ? ' · devnex.config.json' : ''}</small></span>
              </Link>
              <span><StatusPill status={p.status} /></span>
              <span className="num r">{p.services.filter(s => s.status === 'RUNNING').length}/{p.services.length}</span>
              <span className="path" title={p.path}>{p.path}</span>
              <span className="cell-actions">
                {p.origin === 'detected'
                  ? <button className="btn btn-line" onClick={async () => { try { await post(`${API}/projects`, { path: p.path }); onChanged(); setToast({ tone: 'ok', text: `${p.name} registered.` }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } }}><Icon name="plus" size={13} />Keep</button>
                  : <button className="btn btn-line" onClick={async () => { try { await post(`${API}/projects/${p.id}/remove`, {}); onChanged(); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } }}>Remove</button>}
                <Link className="btn btn-ink" href={`/devnex/projects/${p.id}`}>Open</Link>
              </span>
            </div>
          </div>
        )) : <EmptyState title="No projects yet">Start a dev server and DevNEX detects it, or add a folder above. You can also register a whole folder of projects in Settings.</EmptyState>}
      </div>
    </>
  );
}

/** Project detail: header + actions, then Services, Resource usage, Issues, Environment, Runtime, Git, Docker, Logs. */
function ProjectPage({ project: p, cores, updatedAt, busy, onStartProject, onOpenFolder, ...h }: SvcHandlers & {
  project: Project; cores: number; updatedAt: string; busy: boolean; onStartProject: (p: Project) => void; onOpenFolder: (p: Project) => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    get<ProjectDetail>(`/projects/${p.id}`).then(d => { if (alive) { setDetail(d); setError(null); } }).catch(e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [p.id, updatedAt]);
  const up = p.services.filter(s => isUp(s) && s.source !== 'docker-compose');
  const startable = p.services.some(s => s.command && (s.status === 'STOPPED' || s.status === 'FAILED'));
  const web = p.services.filter(s => s.port && isUp(s));
  const svcs = p.services.map(s => ({ ...s, projectName: p.name }));
  const logged = p.services.filter(s => s.hasLogs);
  return (
    <>
      <div className="project-head">
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusPill status={p.status} />
            {detail?.git.isRepo && <span className="pill pill-system"><Icon name="branch" size={12} />{detail.git.branch}</span>}
            <span className="fine" style={{ margin: 0 }}>{p.origin === 'detected' ? 'Detected from a running process' : 'Registered'}{p.packageManager ? ` · ${p.packageManager}` : ''}</span>
          </div>
          <p className="path" style={{ marginTop: 8 }} title={p.path}>{p.path}</p>
        </div>
        <div className="actions">
          <button className="btn btn-line" onClick={() => onOpenFolder(p)}><Icon name="folder" size={14} />Open folder</button>
          {web.map(s => <a key={s.id} className="btn btn-line" href={`http://localhost:${s.port}`} target="_blank" rel="noreferrer"><Icon name="external" size={13} />{s.name} :{s.port}</a>)}
          {p.self && <span className="fine" style={{ margin: 0, alignSelf: 'center' }}>NEX Workbench itself — controlled from its terminal</span>}
          {!p.self && startable && <button className="btn btn-ink" disabled={busy} onClick={() => onStartProject(p)}><Icon name="play" size={13} />{up.length ? 'Start the rest' : 'Start'}</button>}
          {!p.self && !!up.length && <button className="btn btn-line" onClick={() => h.onConfirm({ kind: 'restart-project', project: p })}>Restart</button>}
          {!p.self && !!up.length && <button className="btn btn-line" onClick={() => h.onConfirm({ kind: 'stop-project', project: p })}><Icon name="stop" size={13} />Stop</button>}
        </div>
      </div>

      <div className="table" role="table" aria-label="Services">
        <div className="tr th cols-services" role="row"><span>Service</span><span>Status</span><span>Port</span><span className="r">CPU</span><span>Memory</span><span /></div>
        <ServiceRows services={svcs} cores={cores} showProject={false} readOnly={p.self} {...h} />
      </div>

      <div className="bento" style={{ marginTop: 12 }}>
        <article className="tile span-4">
          <p className="eyebrow">Resource usage</p>
          <dl className="spec">
            <div><dt>CPU</dt><dd>{pct(p.usage.cpuPercent, cores)}</dd></div>
            <div><dt>RAM</dt><dd>{fmtBytes(p.usage.memoryBytes)}</dd></div>
            <div><dt>Processes</dt><dd>{p.usage.processCount}</dd></div>
          </dl>
          <p className="fine">{BASIS[p.usage.basis]}.</p>
        </article>
        <article className="tile span-8">
          <p className="eyebrow">Issues</p>
          {detail ? (detail.issues.length ? detail.issues.map(i => <IssueRow key={i.id} issue={i} />) : <EmptyState title="No issues">Ports, services, environment and runtime all check out.</EmptyState>)
            : <p className="fine">{error ?? 'Reading…'}</p>}
        </article>

        <article className="tile span-4">
          <p className="eyebrow"><Icon name="branch" size={13} /> Git</p>
          {!detail ? <p className="fine">Reading…</p> : detail.git.isRepo ? (
            <dl className="kv">
              <dt>Branch</dt><dd>{detail.git.branch}</dd>
              <dt>Changed files</dt><dd>{detail.git.changed}{detail.git.untracked ? ` · ${detail.git.untracked} untracked` : ''}</dd>
              <dt>Uncommitted</dt><dd>{detail.git.changed + detail.git.untracked ? 'Yes' : 'No'}</dd>
              <dt>Ahead / behind</dt><dd>{detail.git.upstream ? `${detail.git.ahead} / ${detail.git.behind}` : 'No upstream'}</dd>
            </dl>
          ) : <p className="fine">{detail.git.detail}</p>}
          <p className="fine">Read-only. DevNEX never commits, pulls or pushes.</p>
        </article>
        <article className="tile span-4">
          <p className="eyebrow">Runtime</p>
          {!detail ? <p className="fine">Reading…</p> : detail.runtime.length ? (
            <dl className="kv">
              {detail.runtime.map(r => (
                <Fragment key={r.tool}><dt>{r.tool} {r.required}</dt><dd style={{ color: r.status === 'mismatch' || r.status === 'missing' ? 'var(--critical)' : undefined }}>{r.installed ?? 'missing'} · {r.status === 'ok' ? 'OK' : r.status === 'mismatch' ? 'Version mismatch' : r.status}</dd></Fragment>
              ))}
            </dl>
          ) : <p className="fine">No runtime requirement declared (engines, .nvmrc, packageManager).</p>}
        </article>
        <article className="tile span-4">
          <p className="eyebrow"><Icon name="container" size={13} /> Docker</p>
          {!detail ? <p className="fine">Reading…</p> : detail.containers.length ? (
            <dl className="kv">{detail.containers.map(c => <Fragment key={c.id}><dt>{c.name}</dt><dd style={{ color: /Exited \((?!0\))/.test(c.status) ? 'var(--critical)' : undefined }}>{c.status}</dd></Fragment>)}</dl>
          ) : <p className="fine">{p.signals.compose ? 'No containers found for this project’s compose file.' : 'No compose file in this project.'}</p>}
        </article>

        <article className="tile span-8">
          <div className="tile-head">
            <div><p className="eyebrow"><Icon name="env" size={13} /> Environment</p><h3>{detail?.env.expectedFrom ? `${detail.env.configured} configured · ${detail.env.missing} missing` : 'Variables'}</h3></div>
            <Link className="btn btn-ghost" href={`/devnex/environment?project=${p.id}`}>Details <Icon name="arrow" size={16} /></Link>
          </div>
          {!detail ? <p className="fine">Reading…</p> : detail.env.rows.length ? <EnvTable rows={detail.env.rows.slice(0, 8)} /> : <p className="fine">No .env or .env.example files.</p>}
          {detail && detail.env.rows.length > 8 && <p className="fine">+ {detail.env.rows.length - 8} more</p>}
        </article>
        <article className="tile span-4">
          <p className="eyebrow"><Icon name="logs" size={13} /> Logs</p>
          {logged.length ? <div style={{ display: 'grid', gap: 6 }}>{logged.map(s => <button key={s.id} className="btn btn-line" style={{ justifyContent: 'flex-start' }} onClick={() => h.onLogs(s.id)}>{s.name}</button>)}</div>
            : <p className="fine">Logs appear for services you start from DevNEX.</p>}
        </article>
      </div>
    </>
  );
}

/* ───────────────────────── Ports ───────────────────────── */
function Ports({ data, onConfirm, initialQuery }: { data: { ports: PortEntry[]; conflicts: PortConflict[] } | null; onConfirm: (c: Confirm) => void; initialQuery: string }) {
  const [filter, setFilter] = useState<'All' | 'Projects' | 'Unknown' | 'Network'>(initialQuery ? 'All' : 'Projects');
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<'Port' | 'Process' | 'Project'>('Port');
  const [ignored, setIgnored] = useState<string[]>([]);
  const [open, setOpen] = useState<number | null>(initialQuery && /^\d+$/.test(initialQuery) ? Number(initialQuery) : null);
  useEffect(() => { if (initialQuery) { setQuery(initialQuery); setFilter('All'); if (/^\d+$/.test(initialQuery)) setOpen(Number(initialQuery)); } }, [initialQuery]);
  if (!data) return <EmptyState title="Reading listening ports…" />;
  const q = query.trim().toLowerCase();
  const list = data.ports
    .filter(p => (filter === 'All' || (filter === 'Projects' ? !p.unknown : filter === 'Unknown' ? p.unknown : p.exposure === 'network'))
      && (!q || (/^\d+$/.test(q) ? String(p.port).startsWith(q) : `${p.port} ${p.processName} ${p.projectName ?? ''} ${p.serviceName ?? ''}`.toLowerCase().includes(q))))
    .sort((a, b) => sort === 'Port' ? a.port - b.port : sort === 'Process' ? (a.processName ?? '').localeCompare(b.processName ?? '') : (a.projectName ?? '~').localeCompare(b.projectName ?? '~'));
  const counts = { All: data.ports.length, Projects: data.ports.filter(p => !p.unknown).length, Unknown: data.ports.filter(p => p.unknown).length, Network: data.ports.filter(p => p.exposure === 'network').length };
  return (
    <>
      {data.conflicts.filter(c => !ignored.includes(`${c.port}:${c.requestedBy.serviceId}`)).map(c => (
        <div className="conflict" key={`${c.port}:${c.requestedBy.serviceId}`}>
          <p className="eyebrow tone-text-critical">Port conflict</p>
          <h3 className="section-title" style={{ margin: 0 }}>Port {c.port} is already in use.</h3>
          <dl className="kv">
            <dt>Current owner</dt><dd>{c.usedBy.processName ?? 'unknown'}{c.usedBy.pid ? ` · PID ${c.usedBy.pid}` : ''}</dd>
            <dt>Associated project</dt><dd>{c.usedBy.projectName ?? 'not tied to a known project'}</dd>
            <dt>Requested by</dt><dd>{c.requestedBy.projectName} / {c.requestedBy.serviceName}</dd>
          </dl>
          <div className="row">
            <button className="btn btn-line" onClick={() => { setFilter('All'); setQuery(String(c.port)); setOpen(c.port); }}>View process</button>
            {c.usedBy.pid && <button className="btn btn-ink" onClick={() => onConfirm({ kind: 'stop-process', pid: c.usedBy.pid!, name: c.usedBy.processName ?? 'process', port: c.port, context: `${c.requestedBy.projectName} › ${c.requestedBy.serviceName} needs port ${c.port}.` })}>Stop process…</button>}
            <button className="btn btn-ghost" onClick={() => setIgnored(x => [...x, `${c.port}:${c.requestedBy.serviceId}`])}>Ignore</button>
          </div>
        </div>
      ))}
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Search port, process or project" />
        <FilterChips options={['Projects', 'Unknown', 'Network', 'All'] as const} value={filter} onChange={setFilter} counts={counts} />
        <label className="sort">Sort
          <select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>{(['Port', 'Process', 'Project'] as const).map(s => <option key={s}>{s}</option>)}</select>
        </label>
      </div>
      <div className="table" role="table" aria-label="Listening ports">
        <div className="tr th cols-ports" role="row"><span>Port</span><span>Reachable</span><span>Process</span><span>Project / service</span><span /></div>
        {list.length ? list.map(p => (
          <div className={`row-wrap ${open === p.port ? 'open' : ''}`} key={`${p.pid}:${p.address}:${p.port}`}>
            <div className="tr cols-ports">
              <span className="num"><b>{p.port}</b></span>
              <span>{p.exposure === 'network' ? <Pill tone="warn">Network</Pill> : <Pill tone="muted">Local</Pill>}</span>
              <button className="cell-app" onClick={() => setOpen(open === p.port ? null : p.port)} aria-expanded={open === p.port}>
                <span className="chev"><Icon name="chevron" size={14} /></span>
                <span><b>{p.processName ?? 'unknown'}</b><small>{p.pid ? `PID ${p.pid}` : 'owner hidden by the OS'} · {p.address}</small></span>
              </button>
              <span>{p.projectName ? <><b>{p.projectName}</b>{p.serviceName && <small className="fine" style={{ display: 'block', margin: 0 }}>{p.serviceName}</small>}</> : <span className="fine" style={{ margin: 0 }}>Unknown process</span>}</span>
              <span className="cell-actions">
                {p.pid && p.projectId && <button className="btn btn-line" onClick={() => onConfirm({ kind: 'stop-process', pid: p.pid!, name: p.processName ?? 'process', port: p.port })}><Icon name="stop" size={13} />Stop</button>}
              </span>
            </div>
            {open === p.port && (
              <div className="children">
                <dl className="kv">
                  <dt>Command</dt><dd className="mono" title={p.command ?? ''}>{p.command ?? '—'}</dd>
                  <dt>Working directory</dt><dd className="mono">{p.cwd ?? '—'}</dd>
                  <dt>Bound to</dt><dd>{p.address}{p.exposure === 'network' ? ' — other devices on your network can connect' : ' — this machine only'}</dd>
                  <dt>Project</dt><dd>{p.projectName ? `${p.projectName} (matched by working directory / command line)` : 'Not tied to a known project'}</dd>
                </dl>
                {p.pid && !p.projectId && <p className="fine">Unknown processes can only be stopped from the Ports view of a conflicting project, or from MemNEX › Processes.</p>}
              </div>
            )}
          </div>
        )) : <EmptyState title="No ports match" />}
      </div>
    </>
  );
}

/* ───────────────────────── Logs ───────────────────────── */
function Logs({ services, selected, onSelect }: { services: Svc[]; selected: string | null; onSelect: (id: string) => void }) {
  const managed = services.filter(s => s.hasLogs || s.id === selected);
  const id = selected ?? managed[0]?.id ?? null;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'All' | 'Info' | 'Warning' | 'Error'>('All');
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const pending = useRef<LogLine[]>([]);
  const pausedRef = useRef(false);
  const MAX = 2000; // mirrors the server-side ring buffer
  pausedRef.current = paused;

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLines([]); pending.current = [];
    get<{ lines: LogLine[] }>(`/services/${encodeURIComponent(id)}/logs`).then(r => alive && setLines(r.lines)).catch(() => {});
    const es = new EventSource(`${API}/events?topics=devnex.log`);
    es.addEventListener('devnex.log', ev => {
      const { data } = JSON.parse((ev as MessageEvent).data) as { data: { serviceId: string; line: LogLine } };
      if (data.serviceId !== id) return;
      if (pausedRef.current) pending.current = [...pending.current, data.line].slice(-MAX);
      else setLines(l => [...l, data.line].slice(-MAX));
    });
    return () => { alive = false; es.close(); };
  }, [id]);
  useEffect(() => {
    if (!paused && pending.current.length) { const add = pending.current; pending.current = []; setLines(l => [...l, ...add].slice(-MAX)); }
  }, [paused]);
  useEffect(() => { if (follow && body.current) body.current.scrollTop = body.current.scrollHeight; }, [lines, follow]);

  const visible = lines.filter(l => l.seq > clearedAt && (level === 'All' || l.level === level.toLowerCase()) && (!query || l.text.toLowerCase().includes(query.toLowerCase())));
  const counts = { All: lines.length, Info: lines.filter(l => l.level === 'info').length, Warning: lines.filter(l => l.level === 'warning').length, Error: lines.filter(l => l.level === 'error').length };
  if (!id) return <EmptyState title="No logs yet">Logs appear for services you start from DevNEX (Services or Projects → Start).</EmptyState>;
  return (
    <div className="logview">
      <div className="logview-bar">
        <select className="select" value={id} onChange={e => onSelect(e.target.value)} aria-label="Service" style={selectStyle}>
          {managed.map(s => <option key={s.id} value={s.id}>{s.projectName} › {s.name}</option>)}
        </select>
        <SearchField value={query} onChange={setQuery} placeholder="Search logs" />
        <FilterChips options={['All', 'Info', 'Warning', 'Error'] as const} value={level} onChange={setLevel} counts={counts} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className={`chip ${paused ? 'on' : ''}`} onClick={() => setPaused(p => !p)}>{paused ? `Paused${pending.current.length ? ` · ${pending.current.length} new` : ''}` : 'Pause'}</button>
          <button className={`chip ${follow ? 'on' : ''}`} onClick={() => setFollow(f => !f)}>Auto-scroll</button>
          <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(visible.map(l => `${l.at} ${l.text}`).join('\n'))}><Icon name="copy" size={14} />Copy</button>
          <button className="btn btn-ghost" onClick={() => setClearedAt(lines[lines.length - 1]?.seq ?? 0)}>Clear</button>
        </span>
      </div>
      <div className="logview-body" ref={body} role="log" aria-live="off">
        {visible.length ? visible.map(l => (
          <div key={l.seq} className={`logline lv-${l.level} st-${l.stream}`}>
            <time>{new Date(l.at).toLocaleTimeString()}</time><i aria-hidden /><span>{l.text}</span>
          </div>
        )) : <EmptyState title={lines.length ? 'No lines match' : 'Waiting for output…'} />}
      </div>
      <div className="logview-foot"><span>{visible.length} of {lines.length} lines</span><span>Kept in memory only · last {MAX} lines per service</span></div>
    </div>
  );
}

/* ───────────────────────── Environment ───────────────────────── */
function EnvTable({ rows }: { rows: EnvReport['rows'] }) {
  return (
    <div className="table">
      <div className="tr th cols-env"><span>Variable</span><span>Status</span><span>Value (masked)</span><span>Source</span></div>
      {rows.map(r => (
        <div className="tr cols-env" key={r.key} style={{ borderTop: '1px solid var(--line)' }}>
          <span className="mono"><b>{r.key}</b></span>
          <span><Pill tone={r.status === 'configured' ? 'ok' : r.status === 'extra' ? 'muted' : 'bad'} lock={r.sensitive}>{r.status === 'configured' ? 'Configured' : r.status === 'missing' ? 'Missing' : r.status === 'empty' ? 'Empty' : 'Not in example'}</Pill></span>
          <span className="mono">{r.preview ?? '—'}</span>
          <span className="fine" style={{ margin: 0 }}>{r.source ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

function Environment({ data, initialProject }: { data: EnvData | null; initialProject: string | null }) {
  const [project, setProject] = useState<string | null>(initialProject);
  if (!data) return <EmptyState title="Reading environment…" />;
  const current = data.projects.find(p => p.id === project) ?? data.projects.find(p => p.env.expectedFrom) ?? data.projects[0];
  return (
    <div className="bento">
      <article className="tile span-4">
        <p className="eyebrow">Installed runtimes</p>
        <dl className="spec">{data.runtimes.map(r => <div key={r.name}><dt>{r.name}</dt><dd>{r.version ?? 'not installed'}</dd></div>)}</dl>
        <p className="fine" style={{ marginTop: 14 }}>Docker: {data.docker.available ? `${data.docker.containers.filter(c => c.state === 'running').length} containers running` : data.docker.detail}</p>
        <p className="fine">DevNEX never installs runtimes and never edits .env files.</p>
      </article>
      <article className="tile span-8">
        <div className="tile-head">
          <div><p className="eyebrow">Project environment</p><h3>{current ? current.name : 'No projects'}</h3></div>
          {data.projects.length > 1 && (
            <select className="select" value={current?.id} onChange={e => setProject(e.target.value)} aria-label="Project" style={selectStyle}>
              {data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        {current?.runtime.map(r => (
          <p key={r.tool} className="fine" style={{ margin: '0 0 6px' }}>
            {r.tool}: required <b>{r.required}</b> ({r.source}) · installed <b>{r.installed ?? 'none'}</b> · <span style={{ color: r.status === 'ok' ? undefined : 'var(--critical)' }}>{r.status === 'ok' ? 'OK' : r.status === 'mismatch' ? 'Version mismatch' : r.status}</span>
          </p>
        ))}
        {current && !current.env.files.length && current.env.expectedFrom && <p className="fine tone-text-critical">.env missing — {current.env.expectedFrom} lists {current.env.rows.length} variable{current.env.rows.length === 1 ? '' : 's'}, but no .env / .env.local exists.</p>}
        {current?.env.rows.length ? <div style={{ marginTop: 12 }}><EnvTable rows={current.env.rows} /></div>
          : <EmptyState title="No .env files found">DevNEX compares .env / .env.local against .env.example. Values are masked and never stored.</EmptyState>}
      </article>
    </div>
  );
}

/* ───────────────────────── Settings ───────────────────────── */
function SettingsPage({ theme, setTheme, registry, runtimes, docker, onChanged, setToast }: {
  theme: 'system' | 'light' | 'dark'; setTheme: (t: 'system' | 'light' | 'dark') => void;
  registry: { roots: string[]; projects: string[]; hidden: string[] } | null; runtimes: RuntimeTool[]; docker: DevnexOverview['docker'];
  onChanged: () => void; setToast: (t: { tone: 'ok' | 'error'; text: string }) => void;
}) {
  const [root, setRoot] = useState('');
  const addRoot = async () => {
    try { await post(`${API}/roots`, { path: root }); setRoot(''); onChanged(); setToast({ tone: 'ok', text: 'Folder added. Projects inside it are discovered automatically.' }); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
  };
  return (
    <div className="settings">
      <Setting title="Appearance" text="Shared by the whole Workbench. Follow the system or choose a mode."><Segmented options={['system', 'light', 'dark'] as const} value={theme} onChange={setTheme} /></Setting>
      <Setting title="Project folders" text="DevNEX scans these folders two levels deep for package.json, devnex.config.json or compose files. It never scans the whole disk.">
        <div style={{ display: 'grid', gap: 8, minWidth: 280 }}>
          <div className="tags" style={{ justifyContent: 'flex-start' }}>{registry?.roots.length ? registry.roots.map(r => <span className="tag tag-soft" key={r}>{r}</span>) : <span className="fine">None yet.</span>}</div>
          <div className="add-row"><input value={root} onChange={e => setRoot(e.target.value)} placeholder="~/Documents/projects" aria-label="Folder" onKeyDown={e => e.key === 'Enter' && root && addRoot()} /><button className="btn btn-line" disabled={!root} onClick={addRoot}>Add</button></div>
        </div>
      </Setting>
      <Setting title="Registered projects" text="Projects you added or kept. Detected projects appear automatically while their dev server runs.">
        <div className="tags">{registry?.projects.length ? registry.projects.map(p => <span className="tag tag-soft" key={p} title={p}>{p.split(/[\\/]/).pop()}</span>) : <span className="fine">None yet.</span>}</div>
      </Setting>
      <Setting title="Protected applications" text="Shared with MemNEX. DevNEX won’t stop a protected app or any operating-system process.">
        <Link className="btn btn-line" href="/memnex/settings"><Icon name="lock" size={13} />Manage in MemNEX</Link>
      </Setting>
      <Setting title="Refresh interval" text="Projects, services and ports refresh every 5 s; Git, Docker and runtime versions more slowly. Change the cadence for the whole Workbench in Settings.">
        <Link className="btn btn-line" href="/settings">Workbench settings</Link>
      </Setting>
      <Setting title="Docker" text={docker.available ? `Detected · ${docker.running} running, ${docker.exited} exited. DevNEX reads container status only.` : 'Not available. DevNEX keeps working without it.'}>
        <Pill tone={docker.available ? 'ok' : 'muted'}>{docker.available ? 'Available' : 'Unavailable'}</Pill>
      </Setting>
      <Setting title="Safety" text="DevNEX never kills processes automatically, never edits .env files, never installs runtimes. Secrets are masked and not stored.">
        <span className="chip chip-local"><Icon name="lock" size={13} />Local only</span>
      </Setting>
      <Setting title="DevNEX" text={`Toolchain: ${runtimes.filter(r => r.version).map(r => `${r.name} ${r.version}`).join(' · ')}`}>
        <span className="fine" style={{ margin: 0 }}>v0.3.0</span>
      </Setting>
    </div>
  );
}

