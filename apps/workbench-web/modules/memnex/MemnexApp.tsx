'use client';
/* MemNEX — Local System Intelligence. Moved from apps/memnex-web/app/page.tsx into the Workbench shell; screens unchanged. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AppIcon as UiAppIcon, Compare, Wordmark as UiWordmark, Icon, Meter, Modal, Pill, Setting, Stat, Toast,
  createPost, explain as uiExplain, fmtBytes, fmtUptime, gbNum,
} from '@nex/ui';
import { useWorkbench } from '../../shell/context';
import { PageHeader } from '../../shell/PageHeader';

/* ───────────────────────── Types (mirror modules/memnex/src/types.ts) ───────────────────────── */
type Status = 'Normal' | 'Review' | 'Protected' | 'System Critical';
type Health = 'Healthy' | 'Moderate' | 'High' | 'Critical';
type ProcessItem = { pid: number; name: string; command: string; cpu: number; memory: number; user: string; app: string; protected: boolean; status?: Status; reason?: string; about?: string | null };
type AppKind = 'app' | 'cli' | 'system' | 'memnex';
type AppSummary = { id: string; name: string; kind: AppKind; path: string | null; bundleId: string | null; pids: number[]; mainPid: number; memory: number; cpu: number; status: Status; reasons: string[]; recommended: boolean; suggested: boolean; activeNow: boolean; idleMinutes: number | null; idleAtLeast: boolean; growth: { bytes: number; minutes: number; top: { pid: number; name: string; bytes: number } | null } | null; about: string | null };
type AppGroup = AppSummary & { items: ProcessItem[]; reason?: string };
type Signal = { label: string; value: string; tone: 'ok' | 'warn' | 'bad' };
type InsightAction = { kind: 'close' | 'restart'; appId: string; pid: number; name: string; label: string } | { kind: 'review'; label: string };
type Insight = { tone: 'ok' | 'watch' | 'act'; headline: string; detail: string | null; evidence: string[]; actions: InsightAction[] };
type Snapshot = {
  memory: { total: number; used: number; available: number; percent: number; compressed: number; cached: number; state: Health; rationale: string; pressure: 'normal' | 'warn' | 'critical' | null };
  swap: { total: number; used: number; percent: number; rising: boolean };
  signals: Signal[];
  cpu: { usage: number; cores: number; model: string };
  system: { uptime: number };
  processes: ProcessItem[];
  apps: AppSummary[];
  recommendations: { pid: number; name: string; memory: number; reason: string }[];
  recentlyClosed: { id: string; name: string; closedAt: string }[];
  watchingMinutes: number;
  insight: Insight;
  platform: string;
  updatedAt: string;
};
type Preview = { state: Health; candidates: AppSummary[]; optional: AppSummary[]; restart: AppSummary[]; reclaimable: number; learning: boolean; watchingMinutes: number; note: string };
type CleanupResult = { before: number; after: number; recovered: number; closed: { id: string; name: string }[]; stillRunning: string[]; failed: { name: string; reason: string }[]; durationMs: number };
type Target = { name: string; pid: number; memory: number; perProcess?: boolean; appId?: string; growth?: AppSummary['growth'] };
type Dialog =
  | { kind: 'quit'; t: Target }
  | { kind: 'stuck'; t: Target; detail?: string }
  | { kind: 'kill'; t: Target }
  | { kind: 'restart'; t: Target }
  | { kind: 'cleanup'; items: AppSummary[] };
type Page = 'Overview' | 'Processes' | 'Cleanup' | 'Settings';
type Filter = 'All' | 'High memory' | 'Recommended' | 'Protected' | 'System';
type Sort = 'Memory' | 'CPU' | 'Name' | 'Processes';

const API = '/api/memnex';
const GB = 1024 ** 3;
const HIGH_MEMORY = 1 * GB;
const SMALL_APP = 50 * 1024 ** 2;

/* ───────────────────────── Helpers (shared via @nex/ui) ───────────────────────── */
const fmt = fmtBytes;
const uptime = fmtUptime;
const post = createPost('MemNEX');
const explain = (message: unknown, status: number) => uiExplain(message, status, 'MemNEX');

const isLocked = (g: AppSummary) => g.status === 'System Critical' || g.status === 'Protected';
const asTarget = (g: AppSummary): Target => ({ name: g.name, pid: g.mainPid, memory: g.memory, appId: g.kind === 'app' ? g.id : undefined, growth: g.growth });

/** URL ↔ page: /memnex, /memnex/processes, /memnex/cleanup, /memnex/settings */
const SLUG: Record<Page, string> = { Overview: '', Processes: 'processes', Cleanup: 'cleanup', Settings: 'settings' };
const pageOf = (pathname: string): Page => {
  const slug = pathname.split('/')[2] ?? '';
  return (Object.keys(SLUG) as Page[]).find(p => SLUG[p] === slug) ?? 'Overview';
};
const FILTER_PARAM: Record<string, Filter> = { high: 'High memory', recommended: 'Recommended', protected: 'Protected', system: 'System', all: 'All' };

/* ───────────────────────── App ───────────────────────── */
export function MemnexApp() {
  const router = useRouter();
  const pathname = usePathname() || '/memnex';
  const params = useSearchParams();
  const page = pageOf(pathname);
  const setPage = useCallback((p: Page) => router.push(SLUG[p] ? `/memnex/${SLUG[p]}` : '/memnex'), [router]);
  const { theme, setTheme, every, setBadges, isEnabled } = useWorkbench();
  const [data, setData] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [sort, setSort] = useState<Sort>('Memory');
  const [showSmall, setShowSmall] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'error'; text: string; reopen?: string } | null>(null);
  const [protectedApps, setProtectedApps] = useState<string[]>([]);
  const [keptOpen, setKeptOpen] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/snapshot`);
      if (!r.ok) throw new Error();
      setData(await r.json());
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);
  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch(`${API}/settings`);
      if (r.ok) { const j = await r.json(); setProtectedApps(j.protectedApps ?? []); setKeptOpen(j.keptOpen ?? {}); }
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    loadSettings();
    const t = setInterval(refresh, every(3000));
    return () => clearInterval(t);
  }, [refresh, loadSettings, every]);
  // Sidebar badge for Smart Cleanup (the shell owns the sidebar, MemNEX owns the number).
  useEffect(() => { setBadges('memnex', { cleanup: data?.recommendations.length || undefined }); }, [data?.recommendations.length, setBadges]);
  // Deep links from Home / the command palette, e.g. /memnex/processes?filter=high
  useEffect(() => {
    const f = params.get('filter');
    if (f && FILTER_PARAM[f]) { setFilter(FILTER_PARAM[f]); setSort(f === 'high' ? 'Memory' : sort => sort); }
  }, [params]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.reopen ? 12000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Grouping, status and recommendations come from the API — one source of truth for UI and enforcement.
  const groups = useMemo<AppGroup[]>(() => {
    const byPid = new Map((data?.processes ?? []).map(p => [p.pid, p]));
    return (data?.apps ?? []).map(a => ({
      ...a,
      items: a.pids.map(pid => byPid.get(pid)).filter((p): p is ProcessItem => !!p).sort((x, y) => y.memory - x.memory),
      reason: a.reasons.join(' · ') || undefined,
    }));
  }, [data]);
  const userGroups = useMemo(() => groups.filter(g => g.kind !== 'cli'), [groups]);
  const cliGroups = useMemo(() => groups.filter(g => g.kind === 'cli' && g.memory >= SMALL_APP), [groups]);
  const counts = useMemo(() => ({
    All: userGroups.length,
    'High memory': userGroups.filter(g => g.memory >= HIGH_MEMORY).length,
    Recommended: userGroups.filter(g => g.recommended).length,
    Protected: userGroups.filter(g => g.status === 'Protected').length,
    System: userGroups.filter(g => g.status === 'System Critical').length,
  }), [userGroups]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = userGroups.filter(g => !q || g.name.toLowerCase().includes(q) || g.items.some(p => p.command.toLowerCase().includes(q)));
    if (filter === 'High memory') list = list.filter(g => g.memory >= HIGH_MEMORY);
    if (filter === 'Recommended') list = list.filter(g => g.recommended);
    if (filter === 'Protected') list = list.filter(g => g.status === 'Protected');
    if (filter === 'System') list = list.filter(g => g.status === 'System Critical');
    const by: Record<Sort, (a: AppGroup, b: AppGroup) => number> = {
      Memory: (a, b) => b.memory - a.memory,
      CPU: (a, b) => b.cpu - a.cpu,
      Name: (a, b) => a.name.localeCompare(b.name),
      Processes: (a, b) => b.items.length - a.items.length,
    };
    return [...list].sort(by[sort]);
  }, [userGroups, query, filter, sort]);
  const large = visible.filter(g => g.memory >= SMALL_APP || query || filter !== 'All');
  const small = visible.filter(g => !large.includes(g));
  const maxMem = Math.max(1, ...visible.map(g => g.memory));

  /* ── Actions ── */
  const loadPreview = async () => {
    setResult(null);
    try {
      const r = await fetch(`${API}/cleanup-preview`);
      if (!r.ok) throw new Error(explain((await r.json().catch(() => ({})))?.message, r.status));
      const p: Preview = await r.json();
      setPreview(p);
      setSelected(p.candidates.map(c => c.id)); // optional (pressure normal) ones start unselected
    } catch (e) {
      setToast({ tone: 'error', text: (e as Error).message || 'MemNEX could not build a cleanup preview.' });
    }
  };
  // Entering Smart Cleanup (sidebar, link, palette) always builds a fresh preview.
  const lastPage = useRef<Page | null>(null);
  useEffect(() => {
    if (page === 'Cleanup' && lastPage.current !== 'Cleanup') void loadPreview();
    lastPage.current = page;
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const openCleanup = () => (page === 'Cleanup' ? void loadPreview() : setPage('Cleanup'));

  const quit = async (t: Target) => {
    setBusy(true);
    try {
      const res = await post<{ stillRunning: boolean; detail?: string }>(`${API}/processes/${t.pid}/quit`, { confirmed: true });
      if (res.stillRunning) setDialog({ kind: 'stuck', t, detail: res.detail });
      else { setDialog(null); setToast({ tone: 'ok', text: `${t.name} closed.`, reopen: t.perProcess ? undefined : t.appId }); }
    } catch (e) {
      setDialog(null);
      setToast({ tone: 'error', text: `${t.name}: ${(e as Error).message}` });
    } finally { setBusy(false); refresh(); }
  };
  const kill = async (t: Target) => {
    setBusy(true);
    try {
      const res = await post<{ stillRunning: boolean }>(`${API}/processes/${t.pid}/kill`, { confirmed: true });
      setToast(res.stillRunning ? { tone: 'error', text: `${t.name} is still running. The OS may have blocked the request.` } : { tone: 'ok', text: `${t.name} was force closed.` });
    } catch (e) {
      setToast({ tone: 'error', text: `${t.name}: ${(e as Error).message}` });
    } finally { setBusy(false); setDialog(null); refresh(); }
  };
  const restart = async (t: Target) => {
    setBusy(true);
    try {
      const res = await post<{ stillRunning: boolean; reopened?: boolean; detail?: string }>(`${API}/processes/${t.pid}/restart`, { confirmed: true });
      if (res.stillRunning) setDialog({ kind: 'stuck', t, detail: res.detail });
      else { setDialog(null); setToast({ tone: 'ok', text: `${t.name} restarted with a fresh memory footprint.` }); }
    } catch (e) {
      setDialog(null);
      setToast({ tone: 'error', text: `${t.name}: ${(e as Error).message}` });
    } finally { setBusy(false); refresh(); }
  };
  // Item 8: undo — only for apps MemNEX closed itself (the API enforces this).
  const reopen = async (appId: string, name: string) => {
    try {
      await post(`${API}/apps/reopen`, { appId });
      setToast({ tone: 'ok', text: `Reopening ${name}…` });
      setResult(r => (r ? { ...r, closed: r.closed.filter(c => c.id !== appId) } : r));
    } catch (e) {
      setToast({ tone: 'error', text: `${name}: ${(e as Error).message}` });
    } finally { setTimeout(refresh, 1500); }
  };
  const suggestAgain = async (name: string) => {
    try {
      const s = await post<{ keptOpen: Record<string, number> }>(`${API}/settings/suggest-again`, { app: name });
      setKeptOpen(s.keptOpen ?? {});
      setToast({ tone: 'ok', text: `MemNEX will suggest ${name} again when it’s idle.` });
    } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    refresh();
  };
  const runInsight = (a: InsightAction) => {
    if (a.kind === 'review') { setFilter('All'); setSort('Memory'); setPage('Processes'); return; }
    const app = data?.apps.find(x => x.id === a.appId);
    if (!app) return setToast({ tone: 'error', text: `${a.name}: Process no longer exists.` });
    setDialog({ kind: a.kind === 'restart' ? 'restart' : 'quit', t: asTarget(app) });
  };
  const toggleProtect = async (name: string, value: boolean) => {
    try {
      const s = await post<{ protectedApps: string[] }>(`${API}/settings/protected`, { app: name, protected: value });
      setProtectedApps(s.protectedApps ?? []);
      setToast({ tone: 'ok', text: value ? `${name} is now protected.` : `${name} is no longer protected.` });
    } catch (e) {
      setToast({ tone: 'error', text: (e as Error).message });
    }
    refresh();
  };
  const runCleanup = async () => {
    setBusy(true);
    try {
      const shownIds = [...(preview?.candidates ?? []), ...(preview?.optional ?? [])].map(a => a.id);
      setResult(await post<CleanupResult>(`${API}/cleanup`, { appIds: selected, shownIds, confirmed: true }));
      loadSettings();
      setSelected([]);
    } catch (e) {
      setToast({ tone: 'error', text: (e as Error).message });
    } finally { setBusy(false); setDialog(null); refresh(); }
  };

  /* ── Boot / offline ── */
  if (!isEnabled('memnex')) return (
    <div className="boot boot-inline">
      <Wordmark />
      <h1>MemNEX is turned off.</h1>
      <p>Turn it back on in <Link href="/settings">Workbench settings</Link>.</p>
    </div>
  );
  if (loading) return <div className="boot boot-inline"><Wordmark /><p>Reading your system…</p></div>;
  if (!data) return (
    <div className="boot boot-inline">
      <Wordmark />
      <h1>MemNEX can’t reach its local service.</h1>
      <p>Run <code>npm run dev</code> in the NEXWorkbench folder, then this page reconnects on its own.</p>
    </div>
  );

  const health = data.memory.state;
  const tone = health.toLowerCase();
  const selectedItems = [...(preview?.candidates ?? []), ...(preview?.optional ?? [])].filter(c => selected.includes(c.id));
  const selectedTotal = selectedItems.reduce((n, p) => n + p.memory, 0);
  const cpuShare = (cpu: number) => Math.min(100, cpu / Math.max(1, data.cpu.cores));

  return (
    <>
      <section>
        <PageHeader
          crumbs={[{ label: 'MemNEX', href: '/memnex' }, { label: page === 'Cleanup' ? 'Smart Cleanup' : page }]}
          title={page === 'Cleanup' ? 'Smart Cleanup' : page}
          updatedAt={data.updatedAt} offline={offline} onRefresh={refresh} />

        {/* ───────── Overview ───────── */}
        {page === 'Overview' && (
          <div className="bento">
            <article className={`tile tile-health tone-${tone}`}>
              <p className="eyebrow">System health · diagnosis</p>
              <h2 className="state-word">{health}</h2>
              {/* Diagnosis: one cause, the evidence, at most two actions. */}
              <p className="insight-headline">{data.insight.headline}</p>
              {data.insight.detail && <p className="insight-detail">{data.insight.detail}</p>}
              {!!data.insight.evidence.length && (
                <ul className="evidence" aria-label="Evidence">{data.insight.evidence.map(e => <li key={e}>{e}</li>)}</ul>
              )}
              <div className="tile-foot">
                {data.insight.actions.length ? data.insight.actions.map((a, i) => (
                  <button key={a.label} className={i === 0 ? 'btn btn-ink' : 'btn btn-on-tone'} onClick={() => runInsight(a)}>
                    {a.label}{i === 0 && <Icon name="arrow" size={16} />}
                  </button>
                )) : <span className="no-action"><Icon name="check" size={16} />No action needed</span>}
                {data.recommendations.length > data.insight.actions.filter(a => a.kind === 'close').length && (
                  <button className="btn btn-on-tone" onClick={openCleanup}>All {data.recommendations.length} idle apps</button>
                )}
              </div>
            </article>

            <article className="tile tile-memory">
              <p className="eyebrow">Memory in use</p>
              <p className="big-num">{gbNum(data.memory.used)}<span> / {gbNum(data.memory.total)} GB</span></p>
              <Meter value={data.memory.percent} tone={tone} label={`${data.memory.percent.toFixed(0)}% used`} />
              {/* The signals the health verdict is actually based on — "Transparent" (PRD §2). */}
              <dl className="signals">
                {data.signals.map(sg => (
                  <div key={sg.label} className={`signal signal-${sg.tone}`}><dt>{sg.label}</dt><dd><i />{sg.value}</dd></div>
                ))}
              </dl>
            </article>

            <Stat label="Available" value={fmt(data.memory.available)} detail={data.memory.cached ? `incl. ${fmt(data.memory.cached)} file cache` : `${(100 - data.memory.percent).toFixed(0)}% of total`} />
            <Stat label="Swap" value={data.swap.total ? fmt(data.swap.used) : '—'}
              detail={!data.swap.total ? 'Not reported by OS' : data.swap.rising ? 'Growing now' : `of ${fmt(data.swap.total)} · not growing`}
              warn={data.swap.rising} />
            <Stat label="CPU" value={`${data.cpu.usage.toFixed(0)}%`} detail={`across ${data.cpu.cores} cores`} warn={data.cpu.usage > 85} />

            <article className="tile tile-consumers">
              <div className="tile-head">
                <div><p className="eyebrow">Top memory consumers</p><h3>Grouped by application</h3></div>
                <button className="btn btn-ghost" onClick={() => setPage('Processes')}>All apps <Icon name="arrow" size={16} /></button>
              </div>
              <ol className="rank">
                {[...userGroups].sort((a, b) => b.memory - a.memory).slice(0, 5).map((g, i, top) => (
                  <li key={g.name}>
                    <span className="rank-n">{String(i + 1).padStart(2, '0')}</span>
                    <AppIcon {...iconFor(g)} />
                    <span className="rank-name"><b>{g.name}</b><small>{g.items.length} process{g.items.length > 1 ? 'es' : ''}</small></span>
                    <span className="rank-bar"><i style={{ width: `${(g.memory / (top[0]?.memory || 1)) * 100}%` }} /></span>
                    <strong className="num">{fmt(g.memory)}</strong>
                  </li>
                ))}
              </ol>
            </article>

            <article className="tile tile-system">
              <p className="eyebrow">This machine</p>
              <dl className="spec">
                <div><dt>System</dt><dd>{data.platform === 'darwin' ? 'macOS' : 'Windows'}</dd></div>
                <div><dt>Processor</dt><dd title={data.cpu.model}>{data.cpu.model}</dd></div>
                <div><dt>Memory</dt><dd>{fmt(data.memory.total)}</dd></div>
                <div><dt>Uptime</dt><dd>{uptime(data.system.uptime)}</dd></div>
              </dl>
            </article>
          </div>
        )}

        {/* ───────── Processes ───────── */}
        {page === 'Processes' && (
          <>
            <div className="toolbar">
              <label className="search">
                <Icon name="search" size={16} />
                <input placeholder="Search applications" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search applications" />
              </label>
              <div className="chips" role="tablist" aria-label="Filter">
                {(Object.keys(counts) as Filter[]).map(f => (
                  <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                    {f}<span className="num">{counts[f]}</span>
                  </button>
                ))}
              </div>
              <label className="sort">Sort
                <select value={sort} onChange={e => setSort(e.target.value as Sort)}>
                  {(['Memory', 'CPU', 'Name', 'Processes'] as Sort[]).map(s => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>

            <div className="table" role="table" aria-label="Applications">
              <div className="tr th" role="row">
                <span>Application</span><span>Status</span><span className="r">CPU</span><span>Memory</span><span />
              </div>
              {large.map(g => (
                <AppRow key={g.id} g={g} max={maxMem} open={open === g.id} cpu={cpuShare(g.cpu)}
                  onToggle={() => setOpen(open === g.id ? null : g.id)}
                  onQuit={() => setDialog({ kind: 'quit', t: asTarget(g) })}
                  onKill={() => setDialog({ kind: 'kill', t: asTarget(g) })}
                  onStop={p => setDialog({ kind: 'quit', t: { name: `${g.name} (PID ${p.pid})`, pid: p.pid, memory: p.memory, perProcess: true } })}
                  onRestart={() => setDialog({ kind: 'restart', t: asTarget(g) })}
                  onProtect={v => toggleProtect(g.name, v)} />
              ))}
              {!visible.length && <p className="empty">No applications match “{query || filter}”.</p>}
            </div>
            {!!small.length && (
              <button className="btn btn-ghost more" onClick={() => setShowSmall(s => !s)}>
                {showSmall ? 'Hide' : 'Show'} {small.length} smaller apps under 50 MB
              </button>
            )}
            {showSmall && (
              <div className="table">
                {small.map(g => (
                  <AppRow key={g.id} g={g} max={maxMem} open={open === g.id} cpu={cpuShare(g.cpu)}
                    onToggle={() => setOpen(open === g.id ? null : g.id)}
                    onQuit={() => setDialog({ kind: 'quit', t: asTarget(g) })}
                    onKill={() => setDialog({ kind: 'kill', t: asTarget(g) })}
                    onStop={p => setDialog({ kind: 'quit', t: { name: `${g.name} (PID ${p.pid})`, pid: p.pid, memory: p.memory, perProcess: true } })}
                  onRestart={() => setDialog({ kind: 'restart', t: asTarget(g) })}
                    onProtect={v => toggleProtect(g.name, v)} />
                ))}
              </div>
            )}

            {!!cliGroups.length && !query && filter === 'All' && (
              <section className="section">
                <p className="eyebrow">Command-line & background</p>
                <h3 className="section-title">Dev servers, runtimes and tools</h3>
                <p className="fine section-note">These aren’t apps with a Quit menu, so MemNEX stops them one process at a time. Expand a row to choose which.</p>
                <div className="table">
                  {cliGroups.map(g => (
                    <AppRow key={g.id} g={g} max={maxMem} open={open === g.id} cpu={cpuShare(g.cpu)}
                      onToggle={() => setOpen(open === g.id ? null : g.id)}
                      onQuit={() => setOpen(g.id)}
                      onKill={() => {}}
                      onStop={p => setDialog({ kind: 'quit', t: { name: `${g.name} (PID ${p.pid})`, pid: p.pid, memory: p.memory, perProcess: true } })}
                  onRestart={() => setDialog({ kind: 'restart', t: asTarget(g) })}
                      onProtect={v => toggleProtect(g.name, v)} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* ───────── Smart Cleanup ───────── */}
        {page === 'Cleanup' && (
          result ? (
            <div className="bento">
              <article className="tile tile-result tone-healthy">
                <p className="eyebrow">Cleanup complete</p>
                <p className="big-num">{fmt(result.recovered)}</p>
                <p className="state-copy">released by closed apps in {(result.durationMs / 1000).toFixed(1)} sec</p>
              </article>
              <article className="tile tile-compare">
                <p className="eyebrow">System memory before → after</p>
                <Compare label="Before" value={result.before} max={Math.max(result.before, result.after)} />
                <Compare label="After" value={result.after} max={Math.max(result.before, result.after)} />
                <p className="fine">Freed memory can be reused by the OS immediately; the system figure moves as other apps allocate.</p>
              </article>
              <article className="tile tile-closed">
                <div>
                  <p className="eyebrow">Closed — changed your mind?</p>
                  <ul className="closed">
                    {result.closed.length ? result.closed.map(c => (
                      <li key={c.id}><Icon name="check" size={16} />{c.name}<button className="chip-action" onClick={() => reopen(c.id, c.name)}>Reopen</button></li>
                    )) : <li>Nothing was closed.</li>}
                  </ul>
                  {!!result.stillRunning.length && <p className="fine">Still open (may be asking to save): {result.stillRunning.join(', ')}</p>}
                  {result.failed.map(f => <p className="fine tone-text-critical" key={f.name}>{f.name}: {f.reason}</p>)}
                </div>
                <button className="btn btn-line" onClick={openCleanup}>Review again</button>
              </article>
            </div>
          ) : (
            <div className="cleanup">
              <div className="cleanup-main">
                <section className="cleanup-list">
                  <p className="eyebrow">Smart cleanup, not blind cleanup</p>
                  <h2 className="h2">
                    {!preview ? 'Reading your apps…'
                      : preview.candidates.length ? `${preview.candidates.length} app${preview.candidates.length > 1 ? 's' : ''} you aren’t using`
                      : preview.learning && (preview.state === 'High' || preview.state === 'Critical') ? 'Learning which apps you use…'
                      : preview.state === 'High' || preview.state === 'Critical' ? 'Nothing safe to close right now.'
                      : 'No cleanup necessary.'}
                  </h2>
                  {!(preview?.learning && !preview.candidates.length) && <p className="lede">{preview?.note}</p>}
                  {preview?.learning && !preview.candidates.length && (
                    <div className="learning">
                      <span>Watching which apps you use · {preview.watchingMinutes} of 20 min. Suggestions appear once MemNEX knows what you haven’t touched.</span>
                      <span className="bar"><i style={{ width: `${Math.min(100, (preview.watchingMinutes / 20) * 100)}%` }} /></span>
                    </div>
                  )}
                  {preview?.candidates.map(a => <Pick key={a.id} a={a} on={selected.includes(a.id)} toggle={() => setSelected(s => (s.includes(a.id) ? s.filter(x => x !== a.id) : [...s, a.id]))} />)}
                </section>

                {!!preview?.optional.length && (
                  <section className="cleanup-list">
                    <p className="eyebrow">Optional</p>
                    <h3 className="section-title">Idle apps you could close anyway</h3>
                    <p className="lede">Memory pressure is normal, so this isn’t needed. These apps haven’t been used for a while and aren’t doing background work.</p>
                    {preview.optional.map(a => <Pick key={a.id} a={a} on={selected.includes(a.id)} toggle={() => setSelected(s => (s.includes(a.id) ? s.filter(x => x !== a.id) : [...s, a.id]))} />)}
                  </section>
                )}

                {!!preview?.restart.length && (
                  <section className="cleanup-list">
                    <p className="eyebrow">Growing memory</p>
                    <h3 className="section-title">Restart to reclaim</h3>
                    <p className="lede">These apps keep growing while you use them — often a leak. Restarting gives the memory back and reopens the app.</p>
                    {preview.restart.map(a => (
                      <div className="pick on" key={a.id}>
                        <span className="growth-mark" aria-hidden>↗</span>
                        <AppIcon pid={a.mainPid} />
                        <span><b>{a.name}</b><small>Grew {fmt(a.growth!.bytes)} in {a.growth!.minutes} min · now {fmt(a.memory)}</small></span>
                        <button className="btn btn-line" onClick={() => setDialog({ kind: 'restart', t: asTarget(a) })}>Restart</button>
                      </div>
                    ))}
                  </section>
                )}
              </div>
              {!!(preview?.candidates.length || preview?.optional.length) && (
                <aside className={`tile tile-recovery ${preview?.candidates.length ? '' : 'is-optional'}`}>
                  <p className="eyebrow">Potential memory recovery</p>
                  <p className="big-num">{fmt(selectedTotal)}</p>
                  <p className="state-copy">{selectedItems.length} idle app{selectedItems.length === 1 ? '' : 's'} selected</p>
                  <button className="btn btn-ink wide" disabled={!selectedItems.length} onClick={() => setDialog({ kind: 'cleanup', items: selectedItems })}>
                    Close {selectedItems.length} app{selectedItems.length === 1 ? '' : 's'} <Icon name="arrow" size={16} />
                  </button>
                  <p className="fine">Estimate. You can reopen anything MemNEX closes for the next hour.</p>
                </aside>
              )}
            </div>
          )
        )}

        {/* ───────── Settings ───────── */}
        {page === 'Settings' && (
          <div className="settings">
            <Setting title="Appearance" text="Shared by the whole Workbench. Follow the system or choose a mode.">
              <div className="segmented">
                {(['system', 'light', 'dark'] as const).map(t => (
                  <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
                ))}
              </div>
            </Setting>
            <Setting title="Protected applications" text="Never recommended for cleanup and can’t be quit from MemNEX. System processes are always protected.">
              <div className="tags">
                {protectedApps.length ? protectedApps.map(a => (
                  <span className="tag" key={a}><Icon name="lock" size={13} />{a}
                    <button aria-label={`Unprotect ${a}`} onClick={() => toggleProtect(a, false)}><Icon name="close" size={13} /></button>
                  </span>
                )) : <span className="fine">None yet. Use Protect on the Processes page.</span>}
              </div>
            </Setting>
            <Setting title="Apps you usually keep open" text="Learned from your choices: after you keep an idle app open 3 times, MemNEX stops suggesting it.">
              <div className="tags">
                {Object.entries(keptOpen).filter(([, n]) => n >= 3).length ? Object.entries(keptOpen).filter(([, n]) => n >= 3).map(([a]) => (
                  <span className="tag tag-soft" key={a}>{a}
                    <button aria-label={`Suggest ${a} again`} title="Suggest again" onClick={() => suggestAgain(a)}><Icon name="close" size={13} /></button>
                  </span>
                )) : <span className="fine">Nothing learned yet.</span>}
              </div>
            </Setting>
            <Setting title="Local data" text="Metrics are read from this computer only. Nothing is sent to a cloud service.">
              <span className="chip chip-local"><Icon name="lock" size={13} />Local only</span>
            </Setting>
          </div>
        )}
      </section>

      {/* ───────── Dialogs ───────── */}
      {dialog && (
        <Modal onClose={() => setDialog(null)} busy={busy}>
            {dialog.kind === 'quit' && <>
              <p className="eyebrow">Quit application</p>
              <h2 className="h2">Quit {dialog.t.name}?</h2>
              <p>{dialog.t.perProcess
                ? <>MemNEX sends this process a normal stop signal (like Ctrl+C). About <b>{fmt(dialog.t.memory)}</b> would be released.</>
                : <>MemNEX asks the app to close normally, like choosing Quit from its menu. It may ask you to save work. About <b>{fmt(dialog.t.memory)}</b> would be released.</>}</p>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
                <button className="btn btn-ink" onClick={() => quit(dialog.t)} disabled={busy}>{busy ? 'Waiting for app…' : 'Quit'}</button>
              </div>
            </>}
            {dialog.kind === 'stuck' && <>
              <p className="eyebrow tone-text-high">Application did not close</p>
              <h2 className="h2">{dialog.t.name} is still running.</h2>
              <p>{dialog.detail ?? 'It may be waiting for you to save, or it refused a normal quit.'} Check the app first. Force close ends it immediately and <b>unsaved work will be lost</b>.</p>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
                <button className="btn btn-danger" onClick={() => kill(dialog.t)} disabled={busy}>Force close</button>
              </div>
            </>}
            {dialog.kind === 'kill' && <>
              <p className="eyebrow tone-text-critical">Force close</p>
              <h2 className="h2">Force close {dialog.t.name}?</h2>
              <p>This skips the app’s own quit routine. <b>Unsaved work will be lost.</b> Try Quit first when you can.</p>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
                <button className="btn btn-danger" onClick={() => kill(dialog.t)} disabled={busy}>Force close</button>
              </div>
            </>}
            {dialog.kind === 'restart' && <>
              <p className="eyebrow">Restart application</p>
              <h2 className="h2">Restart {dialog.t.name}?</h2>
              <p>MemNEX quits it normally (it may ask you to save) and opens it again.{dialog.t.growth && <> It grew <b>{fmt(dialog.t.growth.bytes)}</b> in {dialog.t.growth.minutes} min.</>} Most apps restore their windows.</p>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
                <button className="btn btn-ink" onClick={() => restart(dialog.t)} disabled={busy}>{busy ? 'Restarting…' : 'Restart'}</button>
              </div>
            </>}
            {dialog.kind === 'cleanup' && <>
              <p className="eyebrow">Confirm cleanup</p>
              <h2 className="h2">Close {dialog.items.length} application{dialog.items.length > 1 ? 's' : ''}?</h2>
              <ul className="confirm-list">{dialog.items.map(a => <li key={a.id}><span>{a.name}</span><span className="num">{fmt(a.memory)}</span></li>)}</ul>
              <p>Each app is asked to quit normally. Apps that refuse stay open — MemNEX never force closes during cleanup.</p>
              <div className="modal-actions">
                <button className="btn btn-ghost" onClick={() => setDialog(null)} disabled={busy}>Cancel</button>
                <button className="btn btn-ink" onClick={runCleanup} disabled={busy}>{busy ? 'Closing…' : `Close and recover ~${fmt(selectedTotal)}`}</button>
              </div>
            </>}
        </Modal>
      )}
      {toast && (
        <Toast tone={toast.tone} text={toast.text}
          action={toast.reopen ? { label: 'Reopen', onClick: () => { const id = toast.reopen!; setToast(null); reopen(id, toast.text.replace(/ closed\.$/, '')); } } : undefined} />
      )}
    </>
  );
}

/* ───────────────────────── Components ───────────────────────── */
function Wordmark() {
  return <UiWordmark top="MEM" bottom="NEX" sub={['System', 'Intelligence']} label="MemNEX" />;
}

// Real app icon from the OS (cached locally by the API). No letter monograms: if the OS has no icon,
// show a glyph that says *what kind* of thing it is instead.
function AppIcon({ pid, kind = 'app' }: { pid?: number; kind?: 'app' | 'system' | 'terminal' }) {
  return <UiAppIcon src={pid !== undefined ? `${API}/icon/${pid}` : undefined} kind={kind} />;
}
const iconFor = (g: AppSummary) =>
  g.kind === 'system' ? { kind: 'system' as const } : g.kind === 'app' ? { pid: g.mainPid } : { kind: 'terminal' as const };

function StatusPill({ status, recommended }: { status: Status; recommended?: boolean }) {
  if (status === 'Normal' && !recommended) return null;
  const label = recommended ? 'Review' : status === 'System Critical' ? 'System' : status;
  const cls = recommended || status === 'Review' ? 'review' : status === 'System Critical' ? 'system' : status.toLowerCase();
  return <Pill tone={cls} lock={status === 'Protected' || status === 'System Critical'}>{label}</Pill>;
}

function AppRow({ g, max, open, cpu, onToggle, onQuit, onKill, onStop, onRestart, onProtect }: {
  g: AppGroup; max: number; open: boolean; cpu: number;
  onToggle: () => void; onQuit: () => void; onKill: () => void; onStop: (p: ProcessItem) => void; onRestart: () => void; onProtect: (v: boolean) => void;
}) {
  const system = g.status === 'System Critical';
  const recommended = g.recommended;
  const perProcess = g.kind === 'cli';
  return (
    <div className={`row-wrap ${open ? 'open' : ''}`}>
      <div className="tr" role="row">
        <button className="cell-app" onClick={onToggle} aria-expanded={open}>
          <span className="chev"><Icon name="chevron" size={14} /></span>
          <AppIcon {...iconFor(g)} />
          <span><b>{g.name}</b><small>{g.items.length} process{g.items.length > 1 ? 'es' : ''}{g.reasons[0] ? ` · ${g.reasons[0]}` : ''}</small>{g.about && <small className="about">{g.about}</small>}</span>
        </button>
        <span className="pills"><StatusPill status={g.status} recommended={recommended && !isLocked(g)} />{g.growth && <span className="pill pill-growth" title={`Grew ${fmt(g.growth.bytes)} in ${g.growth.minutes} min`}>↗ Growing</span>}</span>
        <span className="num r">{cpu.toFixed(cpu < 10 ? 1 : 0)}%</span>
        <span className="cell-mem"><span className="num">{fmt(g.memory)}</span><span className="bar"><i style={{ width: `${(g.memory / max) * 100}%` }} /></span></span>
        <span className="cell-actions">
          {!system && (g.status === 'Protected'
            ? <button className="btn btn-line" onClick={() => onProtect(false)}>Unprotect</button>
            : <>
                <button className="btn btn-line" onClick={() => onProtect(true)}><Icon name="lock" size={13} />Protect</button>
                {g.growth && !perProcess && <button className="btn btn-line" onClick={onRestart}>Restart</button>}
                {perProcess
                  ? <button className="btn btn-line" onClick={onToggle}>{open ? 'Hide' : 'Choose'} processes</button>
                  : <button className="btn btn-ink" onClick={onQuit}>Quit</button>}
              </>)}
        </span>
      </div>
      {open && (
        <div className="children">
          <div className={`child th ${perProcess && !isLocked(g) ? 'with-action' : ''}`}><span>PID</span><span>Process</span><span className="r">CPU</span><span className="r">Memory</span><span>User</span>{perProcess && !isLocked(g) && <span />}</div>
          {g.items.slice(0, 40).map(p => (
            <div className={`child ${perProcess && !isLocked(g) ? 'with-action' : ''}`} key={p.pid}>
              <span className="num">{p.pid}</span>
              <span className="proc-cell"><span className="mono" title={p.command}>{p.command || p.name}</span>{p.about && <small className="about">{p.about}</small>}</span>
              <span className="num r">{p.cpu.toFixed(1)}%</span>
              <span className="num r">{fmt(p.memory)}</span>
              <span>{p.user}</span>
              {perProcess && !isLocked(g) && <span className="r"><button className="btn btn-line btn-sm" onClick={() => onStop(p)}>Stop</button></span>}
            </div>
          ))}
          {g.items.length > 40 && <p className="fine">+ {g.items.length - 40} more processes</p>}
          {!isLocked(g) && !perProcess && (
            <div className="danger-zone">
              <span>Not responding to Quit?</span>
              <button className="btn btn-text-danger" onClick={onKill}>Force close…</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Pick({ a, on, toggle }: { a: AppSummary; on: boolean; toggle: () => void }) {
  return (
    <label className={`pick ${on ? 'on' : ''}`}>
      <input type="checkbox" checked={on} onChange={toggle} />
      <AppIcon pid={a.mainPid} />
      <span><b>{a.name}</b><small>{a.reasons.join(' · ')}</small></span>
      <strong className="num">{fmt(a.memory)}</strong>
    </label>
  );
}
