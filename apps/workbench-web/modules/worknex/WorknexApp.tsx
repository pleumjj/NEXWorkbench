'use client';
/* WorkNEX — Work Continuity Intelligence. Pick up where you left off. Remember the work, not the worker. */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AvailableApplication, ContextType, Insights, KnownProject, ResumePlan, ResumeResult, SavedContext, TimelineEntry, TrackedApplication, TrackingLevel, WorkContext, WorknexSettings, WorknexStatus,
} from '@nex/worknex';
import {
  EmptyState, FilterChips, Icon, Modal, Pill, SearchField, Segmented, Setting, Stat, Toast, Wordmark as UiWordmark,
  createPost, fmtBytes, since, useNow, useToast,
} from '@nex/ui';
import { useWorkbench } from '../../shell/context';
import { PageHeader } from '../../shell/PageHeader';

/* ───────────────────────── Types & helpers ───────────────────────── */
type Page = 'Overview' | 'Timeline' | 'Timesheet' | 'Contexts' | 'Saved' | 'Insights' | 'Settings';
type Where = { context: WorkContext; isActive: boolean; recentFile: string | null; related: string[]; changedWhen: string | null } | null;
type Detail = { context: WorkContext; durationMs: number; project: KnownProject | null; memoryBytes: number | null; saved: SavedContext[] };
type TimelineData = { day: string; entries: TimelineEntry[]; sessions: { start: string; end: string; contextIds: string[] }[]; days: string[] };
type SettingsData = { settings: WorknexSettings; rawInMemory: number; sampleSeconds: number };
type Toasty = { tone: 'ok' | 'error'; text: string };
type ResumeTarget = { source: 'contexts' | 'saved'; id: string; title: string };

const API = '/api/worknex';
const post = createPost('WorkNEX');
async function call<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('Lost connection to WorkNEX’s local service. Run npm run dev again.'); }
  // An empty body means "no value" (null) — never an empty object pretending to be data.
  const text = await r.text().catch(() => '');
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`);
  return j as T;
}
const get = <T,>(path: string) => call<T>('GET', path);

const PAGES: Page[] = ['Overview', 'Timeline', 'Timesheet', 'Contexts', 'Saved', 'Insights', 'Settings'];
const slugOf = (p: Page) => (p === 'Overview' ? '' : p.toLowerCase());
const TYPE_LABEL: Record<ContextType, string> = { development: 'Development', document: 'Document', meeting: 'Meeting', research: 'Browsing', general: 'App' };
const TYPE_ICON: Record<ContextType, 'code' | 'logs' | 'activity' | 'search' | 'overview'> = { development: 'code', document: 'logs', meeting: 'activity', research: 'search', general: 'overview' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dur = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const ctxDur = (c: WorkContext, now: number) => c.spans.reduce((n, s, i) => n + ((c.isActive && i === c.spans.length - 1 ? now : new Date(s.end).getTime()) - new Date(s.start).getTime()), 0);
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayLabel = (day: string) => {
  const today = localDay(new Date()), y = new Date(); y.setDate(y.getDate() - 1);
  if (day === today) return 'Today';
  if (day === localDay(y)) return 'Yesterday';
  const [Y, M, D] = day.split('-').map(Number);
  return new Date(Y, M - 1, D).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
};
const lastActive = (c: WorkContext, now: number) => (c.isActive ? 'Active now' : `Last active ${since(c.lastActiveAt, now)}`);

/* ───────────────────────── App ───────────────────────── */
export function WorknexApp() {
  const router = useRouter();
  const pathname = usePathname() || '/worknex';
  const params = useSearchParams();
  const [section, sub] = pathname.split('/').slice(2);
  const page: Page = PAGES.find(p => slugOf(p) === (section ?? '')) ?? 'Overview';
  const { every, isEnabled, refreshSummary, setBadges } = useWorkbench();
  const now = useNow();

  const [status, setStatus] = useState<WorknexStatus | null>(null);
  const [recent, setRecent] = useState<WorkContext[]>([]);
  const [where, setWhere] = useState<Where>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [toast, setToast] = useToast<Toasty>(t => (t.tone === 'error' ? 9000 : 5000));
  const [resumeTarget, setResumeTarget] = useState<ResumeTarget | null>(null);
  const [saveFor, setSaveFor] = useState<WorkContext | 'current' | null>(null);
  const [whereOpen, setWhereOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, r, w] = await Promise.all([get<WorknexStatus>('/status'), get<WorkContext[]>('/recent?limit=12'), get<Where>('/where')]);
      setStatus(s); setRecent(Array.isArray(r) ? r : []); setWhere(w?.context ? w : null); setOffline(false); setUpdatedAt(new Date().toISOString());
    } catch { setOffline(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, every(5000)); return () => clearInterval(t); }, [refresh, every]);
  useEffect(() => { setBadges('worknex', { saved: undefined }); }, [setBadges]);

  const setTracking = useCallback(async (on: boolean) => {
    try {
      await post(`${API}/${on ? 'resume-tracking' : 'pause'}`, {});
      setToast({ tone: 'ok', text: on ? 'WorkNEX is tracking again.' : 'WorkNEX paused. Nothing is being recorded.' });
    } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    refresh(); refreshSummary();
  }, [refresh, refreshSummary, setToast]);

  // Command-palette deep links: ?where=1, ?save=1, ?tracking=on|off, ?resume=1 (context), /saved?resume=<id>.
  useEffect(() => {
    if (params.get('where') === '1') { setWhereOpen(true); router.replace('/worknex'); }
    if (params.get('save') === '1') { setSaveFor('current'); router.replace('/worknex'); }
    const tr = params.get('tracking');
    if (tr === 'on' || tr === 'off') { void setTracking(tr === 'on'); router.replace('/worknex'); }
  }, [params, router, setTracking]);

  if (!isEnabled('worknex')) return (
    <div className="boot boot-inline"><Wordmark /><h1>WorkNEX is turned off.</h1><p>Turn it back on in <Link href="/settings">Workbench settings</Link>.</p></div>
  );
  if (loading) return <div className="boot boot-inline"><Wordmark /><p>Remembering your work…</p></div>;
  if (!status) return (
    <div className="boot boot-inline">
      <Wordmark />
      <h1>WorkNEX can’t reach its local service.</h1>
      <p>Run <code>npm run dev</code> in the NEXWorkbench folder, then this page reconnects on its own.</p>
    </div>
  );

  const crumbs = [{ label: 'WorkNEX', href: '/worknex' }, { label: page, href: sub ? `/worknex/${slugOf(page)}` : undefined }];
  // No consent, no tracking: until the user chooses apps, every page except Settings is the welcome screen.
  const notConfigured = status.trackedApps === 0 && page !== 'Settings' && !(page === 'Saved') && !(page === 'Contexts' && sub);
  const openResume = (t: ResumeTarget) => setResumeTarget(t);

  return (
    <>
      <PageHeader crumbs={sub ? [...crumbs, { label: 'Detail' }] : crumbs} title={page === 'Overview' ? 'Your work' : page} updatedAt={updatedAt} offline={offline} onRefresh={refresh} />

      {status.paused && page !== 'Overview' && (
        <div className="notice"><Icon name="pause" size={16} /><div><b>WorkNEX paused</b>Nothing is being recorded. <button className="chip-action" onClick={() => setTracking(true)}>Resume tracking</button></div></div>
      )}
      {!status.paused && status.detection !== 'full' && page === 'Overview' && (
        <div className="notice"><Icon name="alert" size={16} /><div><b>Limited activity detection</b>{status.detectionDetail}</div></div>
      )}

      {notConfigured && <Welcome />}
      {!notConfigured && page === 'Overview' && <Overview status={status} recent={recent} where={where} now={now}
        onResume={openResume} onSave={setSaveFor} onWhere={() => setWhereOpen(true)} onTracking={setTracking} />}
      {!notConfigured && page === 'Timeline' && <Timeline now={now} every={every} />}
      {!notConfigured && page === 'Timesheet' && <TimesheetPage every={every} />}
      {!notConfigured && page === 'Contexts' && !sub && <Contexts recent={recent} now={now} />}
      {page === 'Contexts' && sub && <ContextDetail id={sub} now={now} autoResume={params.get('resume') === '1'} onResume={openResume} onSave={setSaveFor} />}
      {page === 'Saved' && <Saved now={now} resumeId={params.get('resume')} onResume={openResume} setToast={setToast} />}
      {!notConfigured && page === 'Insights' && <InsightsPage />}
      {page === 'Settings' && <SettingsPage status={status} setToast={setToast} onChanged={() => { refresh(); refreshSummary(); }} />}

      {whereOpen && <WhereDialog where={where} now={now} onClose={() => setWhereOpen(false)}
        onResume={c => { setWhereOpen(false); openResume({ source: 'contexts', id: c.id, title: c.title }); }} />}
      {saveFor && <SaveDialog target={saveFor} onClose={() => setSaveFor(null)}
        onSaved={s => { setSaveFor(null); setToast({ tone: 'ok', text: `Saved “${s.label}”.` }); refresh(); refreshSummary(); }} setToast={setToast} />}
      {resumeTarget && <ResumeDialog target={resumeTarget} onClose={() => setResumeTarget(null)}
        onDone={(r, routes) => {
          setResumeTarget(null);
          setToast(r.failed.length ? { tone: 'error', text: `${r.opened.length} opened. ${r.failed.map(f => `${f.label}: ${f.reason}`).join(' ')}` } : { tone: 'ok', text: r.opened.length ? `Reopened ${r.opened.length} item${r.opened.length > 1 ? 's' : ''}.` : 'Opening DevNEX…' });
          refreshSummary();
          if (routes[0]) router.push(routes[0]);
        }} setToast={setToast} />}
      {toast && <Toast tone={toast.tone} text={toast.text} />}
    </>
  );
}

function Wordmark() {
  return <UiWordmark top="WORK" bottom="NEX" sub={['Work', 'Continuity']} label="WorkNEX" variant="ink" />;
}

/* ───────────────────────── Welcome (nothing tracked yet) ───────────────────────── */
function Welcome() {
  return (
    <div className="bento">
      <article className="tile span-7 tile-active">
        <p className="eyebrow">Welcome to WorkNEX</p>
        <h2 className="context-title">Choose what WorkNEX can remember</h2>
        <p style={{ margin: 0, maxWidth: '52ch' }}>WorkNEX helps you remember your work context and resume where you left off. <b>Nothing is tracked unless you choose the apps WorkNEX is allowed to observe.</b> Apps not on your list are ignored — their activity is never saved.</p>
        <dl className="facts"><div><dt>Tracked apps</dt><dd>0</dd></div><div><dt>Status</dt><dd>Not configured</dd></div></dl>
        <div><Link className="btn btn-ink" href="/worknex/settings?add=1"><Icon name="plus" size={14} />Choose apps to track</Link></div>
      </article>
      <article className="tile span-5">
        <p className="eyebrow"><Icon name="lock" size={13} /> Privacy</p>
        <ul className="feed">
          {['Local only — nothing leaves this computer', 'No screenshots', 'No keystrokes', 'No clipboard tracking', 'No cloud upload', 'No productivity scores'].map(x => <li key={x}><span><Icon name="check" size={13} /> {x}</span><span /></li>)}
        </ul>
        <p className="fine">You decide per app how much WorkNEX may know: just that you used it, its window titles and project, or file names too. URLs are always a separate opt-in.</p>
      </article>
    </div>
  );
}

/** "The user should never have to guess what WorkNEX is observing." */
function PrivacySummary({ status }: { status: WorknexStatus }) {
  return (
    <article className="tile span-12">
      <div className="tile-head" style={{ marginBottom: 10 }}>
        <div><p className="eyebrow"><Icon name="lock" size={13} /> Privacy</p><h3>What WorkNEX observes</h3></div>
        <Link className="btn btn-ghost" href="/worknex/settings">Tracked applications <Icon name="arrow" size={16} /></Link>
      </div>
      <dl className="facts">
        <div><dt>Tracked applications</dt><dd>{status.trackedApps}</dd></div>
        <div><dt>Detailed context access</dt><dd>{status.detailedApps} app{status.detailedApps === 1 ? '' : 's'}</dd></div>
        <div><dt>URL tracking</dt><dd>{status.urlApps ? `On for ${status.urlApps} app${status.urlApps === 1 ? '' : 's'}` : 'Off'}</dd></div>
        <div><dt>WorkNEX status</dt><dd>{status.paused ? 'Paused' : 'Tracking approved apps only'}</dd></div>
      </dl>
    </article>
  );
}

/* ───────────────────────── Overview ───────────────────────── */
function Overview({ status, recent, where, now, onResume, onSave, onWhere, onTracking }: {
  status: WorknexStatus; recent: WorkContext[]; where: Where; now: number;
  onResume: (t: ResumeTarget) => void; onSave: (c: WorkContext | 'current') => void; onWhere: () => void; onTracking: (on: boolean) => void;
}) {
  const active = recent.find(c => c.isActive && c.id === status.activeContext?.id) ?? null;
  const others = recent.filter(c => c.id !== active?.id).slice(0, 6);
  return (
    <>
      <div className="quick">
        <button className="btn btn-ink" onClick={onWhere}><Icon name="where" size={15} />Where was I?</button>
        <button className="btn btn-line" onClick={() => onSave('current')} disabled={!recent.length}><Icon name="bookmark" size={15} />Save context</button>
        <Link className="btn btn-line" href="/worknex/timeline"><Icon name="timeline" size={15} />Today’s timeline</Link>
        {status.paused
          ? <button className="btn btn-line" onClick={() => onTracking(true)}><Icon name="play" size={15} />Resume tracking</button>
          : <button className="btn btn-ghost" onClick={() => onTracking(false)}><Icon name="pause" size={15} />Pause WorkNEX</button>}
      </div>

      <div className="bento">
        {status.paused ? (
          <article className="tile tile-paused span-7 tile-active">
            <p className="eyebrow">Privacy mode</p>
            <h2 className="context-title">WorkNEX paused</h2>
            <p style={{ margin: 0, maxWidth: '46ch', fontWeight: 600 }}>Nothing is being recorded from any app — including your tracked apps. Your saved contexts and history are still here.</p>
            <div><button className="btn btn-ink" onClick={() => onTracking(true)}><Icon name="play" size={14} />Resume tracking</button></div>
          </article>
        ) : active ? (
          <article className="tile span-7 tile-active">
            <div className="tile-head" style={{ marginBottom: 0 }}>
              <p className="eyebrow">Active now · {TYPE_LABEL[active.type]}</p>
              <span className="live"><i />Live</span>
            </div>
            <div>
              <h2 className="context-title">{active.title}</h2>
              {active.subtitle && <p className="context-sub">{active.subtitle}</p>}
            </div>
            <dl className="facts">
              <div><dt>Started</dt><dd>{hhmm(active.spans[active.spans.length - 1].start)}</dd></div>
              <div><dt>Apps</dt><dd title={active.applications.map(a => a.name).join(', ')}>{active.applications.slice(0, 3).map(a => a.name).join(', ') || '—'}</dd></div>
              {active.projectPath && <div><dt>Project</dt><dd title={active.projectPath}>{active.projectPath.split(/[\\/]/).pop()}</dd></div>}
              {active.gitBranch && <div><dt>Branch</dt><dd>{active.gitBranch}</dd></div>}
              {active.files[0] && <div><dt>Recent file</dt><dd title={active.files[0].name}>{active.files[0].name}</dd></div>}
            </dl>
            <div className="cell-actions" style={{ justifyContent: 'flex-start' }}>
              <Link className="btn btn-ink" href={`/worknex/contexts/${active.id}`}>View context <Icon name="arrow" size={16} /></Link>
              <button className="btn btn-line" onClick={() => onSave(active)}><Icon name="bookmark" size={14} />Save</button>
            </div>
          </article>
        ) : (
          <article className="tile span-7 tile-active">
            <p className="eyebrow">Active now</p>
            <h2 className="context-title" style={{ color: 'var(--muted)' }}>No tracked application is active.</h2>
            <p className="fine" style={{ margin: 0 }}>{status.detection === 'unavailable' ? status.detectionDetail : `WorkNEX only observes the ${status.trackedApps} app${status.trackedApps === 1 ? '' : 's'} you chose. Other apps and idle time are ignored.`}</p>
          </article>
        )}

        <article className="tile span-5">
          <p className="eyebrow"><Icon name="where" size={13} /> Where was I?</p>
          {where ? <>
            <h3 style={{ fontSize: 20 }}>{where.isActive ? 'You’re working on' : 'You were working on'} {where.context.title}</h3>
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>Last active</dt><dd>{where.isActive ? 'now' : since(where.context.lastActiveAt, now)}</dd>
              {where.recentFile && <><dt>Recent file</dt><dd>{where.recentFile}</dd></>}
              {!!where.related.length && <><dt>Related</dt><dd>{where.related.join(', ')}</dd></>}
            </dl>
            {where.changedWhen && <p className="fine">{where.changedWhen}</p>}
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <button className="btn btn-ink" onClick={() => onResume({ source: 'contexts', id: where.context.id, title: where.context.title })}>Resume <Icon name="arrow" size={16} /></button>
              <Link className="btn btn-line" href={`/worknex/contexts/${where.context.id}`}>Details</Link>
            </div>
          </> : <EmptyState title="No tracked work context yet.">After a few minutes in one of your tracked apps, WorkNEX can tell you where you left off. <Link href="/worknex/settings">Add applications</Link> you want WorkNEX to remember.</EmptyState>}
        </article>

        <Stat className="span-4" label="Contexts today" value={String(status.todayContexts)} detail="Meaningful work, not app switches" />
        <Stat className="span-4" label="Saved contexts" value={String(status.savedContexts)} detail="Your save points" />
        <Stat className="span-4" label="Tracked apps" value={status.paused ? 'Paused' : String(status.trackedApps)} detail={status.detection === 'limited' ? 'Titles need macOS permission' : 'Only apps you chose'} warn={status.detection !== 'full' && !status.paused} />

        <article className="tile span-12">
          <div className="tile-head">
            <div><p className="eyebrow">Continue working</p><h3>{others.length ? 'Recent contexts' : 'No earlier contexts yet'}</h3></div>
            <Link className="btn btn-ghost" href="/worknex/contexts">All contexts <Icon name="arrow" size={16} /></Link>
          </div>
          {others.length ? others.map(c => <ContextRow key={c.id} c={c} now={now} onResume={onResume} />)
            : <EmptyState title="Your recent work appears here">Work in your tracked apps on a couple of projects or documents and they show up with a Resume button.</EmptyState>}
        </article>
        <PrivacySummary status={status} />
      </div>
    </>
  );
}

function ContextRow({ c, now, onResume }: { c: WorkContext; now: number; onResume: (t: ResumeTarget) => void }) {
  return (
    <div className="ctx-row">
      <Link href={`/worknex/contexts/${c.id}`} style={{ color: 'inherit', textDecoration: 'none', minWidth: 0, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span className="app-icon"><Icon name={TYPE_ICON[c.type]} size={16} /></span>
        <span style={{ minWidth: 0 }}>
          <b>{c.title}{c.isSaved && <> <Icon name="bookmark" size={12} /></>}</b>
          <small>{[TYPE_LABEL[c.type], c.gitBranch, c.files[0]?.name ?? c.subtitle, c.applications.slice(0, 3).map(a => a.name).join(', ')].filter(Boolean).join(' · ')}</small>
        </span>
      </Link>
      <span className="when">{lastActive(c, now)}</span>
      <button className="btn btn-line" onClick={() => onResume({ source: 'contexts', id: c.id, title: c.title })}>Resume</button>
    </div>
  );
}

/* ───────────────────────── Timeline ───────────────────────── */
function Timeline({ now, every }: { now: number; every: (ms: number) => number }) {
  const [day, setDay] = useState(() => localDay(new Date()));
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => get<TimelineData>(`/timeline?day=${day}`).then(d => { if (alive) { setData(d); setError(null); } }).catch(e => alive && setError((e as Error).message));
    load();
    const t = setInterval(load, every(15_000));
    return () => { alive = false; clearInterval(t); };
  }, [day, every]);
  const days = useMemo(() => [...new Set([localDay(new Date()), ...(data?.days ?? [])])].slice(0, 10), [data?.days]);
  const total = (data?.entries ?? []).reduce((n, e) => n + ((e.end ? new Date(e.end).getTime() : now) - new Date(e.start).getTime()), 0);
  return (
    <>
      <div className="day-chips" role="tablist" aria-label="Day">
        {days.map(d => <button key={d} role="tab" aria-selected={d === day} className={`chip ${d === day ? 'on' : ''}`} onClick={() => setDay(d)}>{dayLabel(d)}</button>)}
      </div>
      {error && <p className="fine tone-text-critical">{error}</p>}
      {!data ? <EmptyState title="Reading your timeline…" /> : !data.entries.length ? (
        <div className="tl"><EmptyState title={`No work recorded ${dayLabel(day) === 'Today' ? 'yet today' : `for ${dayLabel(day)}`}`}>Contexts appear here as you work in your tracked apps. Idle time, untracked apps and paused periods are never shown.</EmptyState></div>
      ) : (
        <div className="tl" role="list">
          <div className="tl-session">{data.sessions.length} session{data.sessions.length === 1 ? '' : 's'} · {dur(total)} across {new Set(data.entries.map(e => e.contextId)).size} contexts</div>
          {data.entries.map((e, i) => (
            <Link role="listitem" key={`${e.contextId}-${i}`} href={`/worknex/contexts/${e.contextId}`} className={`tl-row ${e.end ? '' : 'is-active'}`}>
              <time>{hhmm(e.start)} – {e.end ? hhmm(e.end) : 'Now'}</time>
              <i aria-hidden />
              <div style={{ minWidth: 0 }}>
                <b>{e.title}</b>
                <small>{TYPE_LABEL[e.type]} · {dur((e.end ? new Date(e.end).getTime() : now) - new Date(e.start).getTime())}{e.brief.length ? ` · brief switch to ${e.brief.slice(0, 3).join(', ')}` : ''}</small>
              </div>
              <Icon name="chevron" size={14} />
            </Link>
          ))}
        </div>
      )}
      <p className="fine section-note" style={{ marginTop: 12 }}>This is your own memory aid, not an attendance record. It shows work contexts — never keystrokes, screenshots or content.</p>
    </>
  );
}

/* ───────────────────────── Timesheet ───────────────────────── */
type TsItem = { key: string; title: string; type: ContextType; projectPath: string | null; minutes: number; hours: number };
type TsDay = { day: string; items: TsItem[]; totalMinutes: number; totalHours: number; itemsHours: number };
const hm = (min: number) => (min < 60 ? `${min} m` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} m`);
const addDays = (day: string, n: number) => { const [y, m, d] = day.split('-').map(Number); return localDay(new Date(y, m - 1, d + n)); };
const mondayOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); const dt = new Date(y, m - 1, d); return addDays(day, -((dt.getDay() + 6) % 7)); };
const roundHalf = (min: number) => Math.round(min / 30) / 2;

/** Your own summary of tracked work — e.g. to fill in Workforce. Exact minutes + hours rounded to 0.5. Nothing is sent anywhere. */
function TimesheetPage({ every }: { every: (ms: number) => number }) {
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [day, setDay] = useState(() => localDay(new Date()));
  const [data, setData] = useState<TsDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = mode === 'day' ? day : mondayOf(day);
  const to = mode === 'day' ? day : addDays(from, 6);
  useEffect(() => {
    let alive = true;
    const load = () => get<TsDay[]>(`/timesheet?from=${from}&to=${to}`).then(d => { if (alive) { setData(d); setError(null); } }).catch(e => alive && setError((e as Error).message));
    load();
    const t = setInterval(load, every(30_000));
    return () => { alive = false; clearInterval(t); };
  }, [from, to, every]);
  const step = (n: number) => setDay(d => addDays(d, mode === 'day' ? n : n * 7));
  const today = localDay(new Date());
  const weekStart = (() => { const [y, m, d] = from.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); })();
  const label = mode === 'day' ? dayLabel(day) : `Week of ${weekStart}`;
  return (
    <>
      <div className="toolbar">
        <Segmented options={['day', 'week'] as const} value={mode} onChange={setMode} label={v => (v === 'day' ? 'Daily' : 'Weekly')} />
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={() => step(-1)} aria-label="Previous"><span style={{ transform: 'rotate(180deg)', display: 'grid' }}><Icon name="chevron" size={14} /></span></button>
          <b style={{ minWidth: 150, textAlign: 'center' }}>{label}</b>
          <button className="btn btn-ghost" onClick={() => step(1)} disabled={to >= today} aria-label="Next"><Icon name="chevron" size={14} /></button>
          {from > today || to < today ? <button className="btn btn-line" onClick={() => setDay(today)}>Today</button> : null}
        </span>
        <a className="btn btn-line" style={{ marginLeft: 'auto' }} href={`${API}/timesheet.csv?from=${from}&to=${to}`} download><Icon name="logs" size={14} />Download CSV</a>
      </div>
      {error && <p className="fine tone-text-critical">{error}</p>}
      {!data ? <EmptyState title="Calculating…" /> : mode === 'day' ? <TsDayTable d={data[0]} /> : <TsWeekTable days={data} />}
      <p className="fine section-note" style={{ marginTop: 12 }}>
        Counted: time a <b>tracked</b> app was in front while you were active, plus tracked meeting apps while a call is running (even if another window is in front — that time goes to the meeting, never counted twice).
        Not counted: untracked apps, idle time, paused periods. Hours are rounded to the nearest 0.5 (2 h 14 m → 2.0, 2 h 15 m → 2.5). This summary stays on your computer.
      </p>
    </>
  );
}

function TsDayTable({ d }: { d: TsDay | undefined }) {
  if (!d || !d.items.length) return <div className="table"><EmptyState title="No tracked work on this day">Only time in apps you track (WorkNEX › Settings) is counted.</EmptyState></div>;
  return (
    <div className="table" role="table" aria-label="Timesheet">
      <div className="tr th cols-ts" role="row"><span>Work</span><span>Type</span><span className="r">Time</span><span className="r">Hours (0.5)</span></div>
      {d.items.map(i => (
        <div className="tr cols-ts" role="row" key={i.key} style={{ borderTop: '1px solid var(--line)' }}>
          <span className="cell-app" style={{ minWidth: 0 }}><span className="app-icon"><Icon name={TYPE_ICON[i.type]} size={16} /></span><span style={{ minWidth: 0 }}><b>{i.title}</b>{i.projectPath && <small className="path">{i.projectPath}</small>}</span></span>
          <span><Pill tone="muted">{TYPE_LABEL[i.type]}</Pill></span>
          <span className="num r">{hm(i.minutes)}</span>
          <span className="num r"><b>{i.hours.toFixed(1)}</b></span>
        </div>
      ))}
      <div className="tr cols-ts th" role="row" style={{ borderTop: '1px solid var(--line)' }}>
        <span>Total</span><span />
        <span className="num r">{hm(d.totalMinutes)}</span>
        <span className="num r" title={`Sum of the rounded rows: ${d.itemsHours.toFixed(1)}`}>{d.totalHours.toFixed(1)}</span>
      </div>
    </div>
  );
}

function TsWeekTable({ days }: { days: TsDay[] }) {
  const rows = new Map<string, { title: string; type: ContextType; perDay: Record<string, number> }>();
  for (const d of days) for (const i of d.items) {
    const r = rows.get(i.key) ?? { title: i.title, type: i.type, perDay: {} };
    r.perDay[d.day] = i.minutes;
    rows.set(i.key, r);
  }
  const list = [...rows.entries()].map(([key, r]) => ({ key, ...r, total: Object.values(r.perDay).reduce((n, m) => n + m, 0) })).sort((a, b) => b.total - a.total);
  if (!list.length) return <div className="table"><EmptyState title="No tracked work this week">Only time in apps you track (WorkNEX › Settings) is counted.</EmptyState></div>;
  const head = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString([], { weekday: 'short', day: 'numeric' }); };
  return (
    <div className="table ts-week" role="table" aria-label="Weekly timesheet">
      <div className="tr th cols-week" role="row"><span>Work</span>{days.map(d => <span key={d.day} className="r">{head(d.day)}</span>)}<span className="r">Total</span></div>
      {list.map(r => (
        <div className="tr cols-week" role="row" key={r.key} style={{ borderTop: '1px solid var(--line)' }}>
          <span style={{ minWidth: 0 }}><b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.title}>{r.title}</b><small className="fine" style={{ margin: 0 }}>{TYPE_LABEL[r.type]}</small></span>
          {days.map(d => { const m = r.perDay[d.day]; return <span key={d.day} className="num r" title={m ? hm(m) : ''}>{m ? roundHalf(m).toFixed(1) : '—'}</span>; })}
          <span className="num r" title={hm(r.total)}><b>{roundHalf(r.total).toFixed(1)}</b></span>
        </div>
      ))}
      <div className="tr th cols-week" role="row" style={{ borderTop: '1px solid var(--line)' }}>
        <span>Total</span>
        {days.map(d => <span key={d.day} className="num r" title={hm(d.totalMinutes)}>{d.totalMinutes ? d.totalHours.toFixed(1) : '—'}</span>)}
        <span className="num r" title={hm(days.reduce((n, d) => n + d.totalMinutes, 0))}>{roundHalf(days.reduce((n, d) => n + d.totalMinutes, 0)).toFixed(1)}</span>
      </div>
    </div>
  );
}

/* ───────────────────────── Contexts ───────────────────────── */
function Contexts({ recent, now }: { recent: WorkContext[]; now: number }) {
  const [all, setAll] = useState<WorkContext[]>(recent);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'All' | 'Development' | 'Document' | 'Meeting' | 'Other'>('All');
  useEffect(() => { get<WorkContext[]>('/contexts').then(setAll).catch(() => {}); }, [recent]);
  const match = (c: WorkContext) => type === 'All' || (type === 'Other' ? !['development', 'document', 'meeting'].includes(c.type) : c.type === type.toLowerCase());
  const list = all.filter(c => match(c) && (!query || `${c.title} ${c.subtitle ?? ''} ${c.projectPath ?? ''} ${c.files.map(f => f.name).join(' ')}`.toLowerCase().includes(query.toLowerCase())));
  const counts = { All: all.length, Development: all.filter(c => c.type === 'development').length, Document: all.filter(c => c.type === 'document').length, Meeting: all.filter(c => c.type === 'meeting').length, Other: all.filter(c => !['development', 'document', 'meeting'].includes(c.type)).length };
  return (
    <>
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Search contexts, projects, files" />
        <FilterChips options={['All', 'Development', 'Document', 'Meeting', 'Other'] as const} value={type} onChange={setType} counts={counts} />
      </div>
      <div className="table" role="table" aria-label="Work contexts">
        <div className="tr th cols-contexts" role="row"><span>Context</span><span>Type</span><span>Apps</span><span>Time</span><span>Last active</span></div>
        {list.length ? list.map(c => (
          <div className="row-wrap" key={c.id}>
            <Link className="tr cols-contexts" role="row" href={`/worknex/contexts/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="cell-app"><span className="app-icon"><Icon name={TYPE_ICON[c.type]} size={16} /></span>
                <span><b>{c.title}{c.isSaved && <> <Icon name="bookmark" size={12} /></>}</b><small>{c.subtitle ?? c.projectPath ?? c.files[0]?.name ?? ''}</small></span></span>
              <span>{c.isActive ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">{TYPE_LABEL[c.type]}</Pill>}</span>
              <span className="fine" style={{ margin: 0 }}>{c.applications.slice(0, 2).map(a => a.name).join(', ')}</span>
              <span className="num">{dur(ctxDur(c, now))}</span>
              <span className="fine" style={{ margin: 0 }}>{c.isActive ? 'now' : since(c.lastActiveAt, now)}</span>
            </Link>
          </div>
        )) : <EmptyState title={all.length ? 'No contexts match' : 'No work contexts yet'}>{all.length ? null : 'They appear after a few minutes of work on a project, document or meeting.'}</EmptyState>}
      </div>
    </>
  );
}

function ContextDetail({ id, now, autoResume, onResume, onSave }: { id: string; now: number; autoResume: boolean; onResume: (t: ResumeTarget) => void; onSave: (c: WorkContext) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    const load = () => get<Detail>(`/contexts/${id}`).then(x => { if (alive) { setD(x); setError(null); } }).catch(e => alive && setError((e as Error).message));
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);
  useEffect(() => {
    if (autoResume && d) { onResume({ source: 'contexts', id: d.context.id, title: d.context.title }); router.replace(`/worknex/contexts/${id}`); }
  }, [autoResume, d, id, onResume, router]);
  if (error) return <EmptyState title="Context not available">{error} <Link href="/worknex/contexts">All contexts</Link></EmptyState>;
  if (!d) return <EmptyState title="Reading context…" />;
  const c = d.context;
  const running = d.project?.services.filter(s => s.running && s.port) ?? [];
  const lastInt = c.interruptions[c.interruptions.length - 1];
  return (
    <>
      <div className="project-head">
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {c.isActive ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">{TYPE_LABEL[c.type]}</Pill>}
            {c.isSaved && <span className="pill pill-system"><Icon name="bookmark" size={12} />Saved</span>}
            <span className="fine" style={{ margin: 0 }}>{lastActive(c, now)}</span>
          </div>
          <h2 className="context-title" style={{ marginTop: 10 }}>{c.title}</h2>
          {c.subtitle && <p className="context-sub">{c.subtitle}</p>}
        </div>
        <div className="actions">
          <button className="btn btn-ink" onClick={() => onResume({ source: 'contexts', id: c.id, title: c.title })}><Icon name="play" size={13} />Resume…</button>
          <button className="btn btn-line" onClick={() => onSave(c)}><Icon name="bookmark" size={14} />Save context</button>
        </div>
      </div>

      <div className="bento">
        <article className="tile span-4">
          <p className="eyebrow">When</p>
          <dl className="kv">
            {c.spans.slice(-6).map((s, i) => <Fragment key={i}><dt>{dayLabel(localDay(new Date(s.start)))}</dt><dd>{hhmm(s.start)} – {c.isActive && i === Math.min(5, c.spans.length - 1) ? 'Now' : hhmm(s.end)}</dd></Fragment>)}
          </dl>
          <p className="fine">{dur(ctxDur(c, now))} in total{c.spans.length > 6 ? ` · ${c.spans.length} stretches` : ''}</p>
          {lastInt && !c.isActive && <p className="fine">{lastInt.kind === 'idle' ? 'You stepped away from the computer.' : `Context changed when ${lastInt.by} became active.`}</p>}
        </article>
        <article className="tile span-4">
          <p className="eyebrow">Applications</p>
          {c.applications.length ? <dl className="kv">{c.applications.map(a => <Fragment key={a.name}><dt>{a.name}</dt><dd>{dur(a.seconds * 1000)}</dd></Fragment>)}</dl> : <p className="fine">—</p>}
          {d.memoryBytes != null && <p className="fine">This context currently uses approximately <b>{fmtBytes(d.memoryBytes)}</b> of RAM.</p>}
        </article>
        <article className="tile span-4">
          <p className="eyebrow"><Icon name="code" size={13} /> Project</p>
          {c.projectPath ? (
            <dl className="kv">
              <dt>Folder</dt><dd className="mono" title={c.projectPath}>{c.projectPath}</dd>
              <dt>Branch</dt><dd>{c.gitBranch ?? '—'}</dd>
              {d.project && <><dt>DevNEX</dt><dd><Link href={`/devnex/projects/${d.project.id}`} style={{ color: 'inherit' }}>{d.project.name}</Link></dd></>}
            </dl>
          ) : <p className="fine">Not tied to a project. WorkNEX links work to DevNEX projects by window title, working folder or localhost port.</p>}
        </article>

        <article className="tile span-4">
          <p className="eyebrow"><Icon name="services" size={13} /> Services</p>
          {d.project?.services.length ? (
            <dl className="kv">{d.project.services.map(s => <Fragment key={s.name}><dt>{s.name}</dt><dd>{s.port ? `localhost:${s.port}` : '—'} · {s.running ? 'Running' : 'Stopped'}</dd></Fragment>)}</dl>
          ) : <p className="fine">No DevNEX services for this context.</p>}
          {!!running.length && <p className="fine">{running.length} running now (live from DevNEX)</p>}
        </article>
        <article className="tile span-4">
          <p className="eyebrow"><Icon name="logs" size={13} /> Files</p>
          {c.files.length ? <ul className="feed">{c.files.map(f => <li key={f.name}><span title={f.path ?? f.name}>{f.name}</span><time>{since(f.lastSeenAt, now)}</time></li>)}</ul>
            : <p className="fine">No file names seen. Files come from window titles (when titles are allowed) or documents the app has open.</p>}
        </article>
        <article className="tile span-4">
          <p className="eyebrow"><Icon name="search" size={13} /> Browser context</p>
          {c.urls.length ? <ul className="feed">{c.urls.map(u => <li key={u.url}><span className="mono" title={u.url}>{u.url}</span><time>{since(u.lastSeenAt, now)}</time></li>)}</ul>
            : <p className="fine">{c.applications.some(a => a.kind === 'browser') ? 'URLs are not recorded (URL tracking is off). Only tab titles, if allowed.' : 'No browser activity in this context.'}</p>}
        </article>

        <article className="tile span-12">
          <p className="eyebrow">How WorkNEX recognized this</p>
          <p className="fine" style={{ marginTop: 0 }}>{c.sourceSignals.map(s => ({ 'foreground-app': 'App in front', 'window-title': 'Window title', 'window-title-file': 'File name in title', 'open-document': 'Document the app has open', 'process-cwd': 'Working folder of the app’s terminals', 'file-path': 'File inside the project', 'localhost-port': 'Local service port' } as Record<string, string>)[s] ?? s).join(' · ')}.
            {d.saved.length ? ` Saved as ${d.saved.map(s => `“${s.label}”`).join(', ')}.` : ''}</p>
        </article>
      </div>
    </>
  );
}

/* ───────────────────────── Saved ───────────────────────── */
function Saved({ now, resumeId, onResume, setToast }: { now: number; resumeId: string | null; onResume: (t: ResumeTarget) => void; setToast: (t: Toasty) => void }) {
  const [list, setList] = useState<SavedContext[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedContext | null>(null);
  const router = useRouter();
  const load = useCallback(() => get<SavedContext[]>('/saved').then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const s = resumeId && list?.find(x => x.id === resumeId);
    if (s) { onResume({ source: 'saved', id: s.id, title: s.label }); router.replace('/worknex/saved'); }
  }, [resumeId, list, onResume, router]);
  const remove = async (s: SavedContext) => {
    try { await call('DELETE', `/saved/${s.id}`); setToast({ tone: 'ok', text: `Deleted save point “${s.label}”.` }); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    setConfirmDelete(null); load();
  };
  if (!list) return <EmptyState title="Reading saved contexts…" />;
  return (
    <>
      <p className="fine section-note">Save points keep references — project folder, files, local URLs, apps, branch, your note. Never application memory or content.</p>
      <div className="table">
        {list.length ? list.map(s => (
          <div className="ctx-row" key={s.id} style={{ padding: '14px 16px' }}>
            <span style={{ minWidth: 0, display: 'flex', gap: 12, alignItems: 'center' }}>
              <span className="app-icon"><Icon name="bookmark" size={16} /></span>
              <span style={{ minWidth: 0 }}>
                <b>{s.label}</b>
                <small>{[TYPE_LABEL[s.type], s.gitBranch, s.applications.slice(0, 3).map(a => a.name).join(', '), s.files.length ? `${s.files.length} file${s.files.length > 1 ? 's' : ''}` : '', s.services.length ? `${s.services.length} service${s.services.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</small>
                {s.note && <small style={{ whiteSpace: 'normal' }}>“{s.note}”</small>}
              </span>
            </span>
            <span className="when">Saved {since(s.savedAt, now)}{s.lastResumedAt ? ` · resumed ${since(s.lastResumedAt, now)}` : ''}</span>
            <span className="cell-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(s)} aria-label={`Delete ${s.label}`}><Icon name="close" size={14} /></button>
              <button className="btn btn-ink" onClick={() => onResume({ source: 'saved', id: s.id, title: s.label })}>Resume</button>
            </span>
          </div>
        )) : <EmptyState title="No saved contexts">Use “Save context” on the Overview or any context to create a checkpoint you can resume later.</EmptyState>}
      </div>
      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(null)}>
          <p className="eyebrow">Delete save point</p>
          <h2 className="h2">Delete “{confirmDelete.label}”?</h2>
          <p>Only the save point is removed. Your files, projects and Git repositories are not touched.</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="btn btn-ink" onClick={() => remove(confirmDelete)}>Delete</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ───────────────────────── Insights ───────────────────────── */
function InsightsPage() {
  const [day, setDay] = useState(() => localDay(new Date()));
  const [ins, setIns] = useState<Insights | null>(null);
  useEffect(() => { get<Insights>(`/insights?day=${day}`).then(setIns).catch(() => setIns(null)); }, [day]);
  const yesterday = (() => { const y = new Date(); y.setDate(y.getDate() - 1); return localDay(y); })();
  return (
    <>
      <div className="day-chips">
        {[localDay(new Date()), yesterday].map(d => <button key={d} className={`chip ${d === day ? 'on' : ''}`} onClick={() => setDay(d)}>{dayLabel(d)}</button>)}
      </div>
      {!ins ? <EmptyState title="Reading…" /> : (
        <div className="bento">
          <Stat className="span-4" label="Major work contexts" value={String(ins.majorContexts)} detail="5 minutes or longer" />
          <Stat className="span-4" label="Longest uninterrupted" value={ins.longestSpanMinutes ? dur(ins.longestSpanMinutes * 60_000) : '—'} detail={ins.longestSpanTitle ?? 'No work recorded'} />
          <Stat className="span-4" label="Average context" value={ins.averageContextMinutes ? dur(ins.averageContextMinutes * 60_000) : '—'} detail="Across major contexts" />
          <article className="tile span-12">
            <p className="eyebrow">Observations</p>
            {ins.observations.length ? <ul className="feed">{ins.observations.map(o => <li key={o}><span>{o}</span><span /></li>)}</ul>
              : <p className="fine" style={{ marginTop: 0 }}>Nothing notable{dayLabel(day) === 'Today' ? ' so far' : ''}.</p>}
            <p className="fine">Descriptive only. WorkNEX never scores productivity or efficiency — it helps you resume, it doesn’t judge.</p>
          </article>
        </div>
      )}
    </>
  );
}

/* ───────────────────────── Settings ───────────────────────── */
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}><i /></button>;
}
const RESUME_LABEL: Record<string, string> = {
  'open-with': 'Project in the editor you used', folder: 'Project folder', terminal: 'Terminal in the project', file: 'Related files',
  'service-url': 'Local service URLs', url: 'Web pages (if URL tracking is on)', devnex: 'DevNEX project', app: 'Other apps',
};

function SettingsPage({ status, setToast, onChanged }: { status: WorknexStatus; setToast: (t: Toasty) => void; onChanged: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [path, setPath] = useState('');
  const [custom, setCustom] = useState('');
  const [clearing, setClearing] = useState(false);
  const [includeSaved, setIncludeSaved] = useState(false);
  const load = useCallback(() => get<SettingsData>('/settings').then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const save = async (patch: Partial<WorknexSettings>, text?: string) => {
    try { await call('PUT', '/settings', patch); if (text) setToast({ tone: 'ok', text }); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    load(); onChanged();
  };
  const clear = async () => {
    try { await call('DELETE', `/history?confirmed=true&includeSaved=${includeSaved}`); setToast({ tone: 'ok', text: includeSaved ? 'Work history and save points deleted.' : 'Work history deleted. Save points kept.' }); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    setClearing(false); onChanged();
  };
  if (!data) return <EmptyState title="Loading settings…" />;
  const s = data.settings;
  const toggle = (k: keyof WorknexSettings, label: string, text: string) => (
    <Setting title={label} text={text}><Switch on={s[k] as boolean} label={label} onChange={v => save({ [k]: v } as Partial<WorknexSettings>)} /></Setting>
  );
  return (
    <>
      <TrackedApps setToast={setToast} onChanged={() => { load(); onChanged(); }} />

      <p className="eyebrow" style={{ marginTop: 28 }}>Defaults for newly added apps</p>
      <div className="settings">
        {toggle('trackWindowTitlesByDefault', 'Window titles by default', 'Off: new apps start at Presence (app name and time only). On: they start at Context (window titles and project).')}
        {toggle('trackFileMetadataByDefault', 'File names by default', 'Off: file names need the Extended level, which you choose per app.')}
        {toggle('trackUrlsByDefault', 'URLs by default', 'Off: URLs are always a separate, per-browser choice.')}
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Privacy</p>
      <div className="settings">
        <Setting title="Pause WorkNEX" text={s.paused ? 'WorkNEX is paused. Nothing is recorded from any app until you resume.' : 'Stop all collection instantly, including from tracked apps. Stays paused until you resume.'}>
          <Switch on={s.paused} label="Pause WorkNEX" onChange={v => save({ paused: v }, v ? 'WorkNEX paused.' : 'WorkNEX is tracking your approved apps again.')} />
        </Setting>
        <Setting title="Excluded folders" text="Even in tracked apps, files and projects inside these folders never appear in contexts; titles mentioning them are dropped.">
          <div style={{ display: 'grid', gap: 8, minWidth: 280 }}>
            <div className="tags" style={{ justifyContent: 'flex-start' }}>
              {s.excludedPaths.length ? s.excludedPaths.map(p => <span className="tag tag-soft" key={p}>{p}<button aria-label={`Stop excluding ${p}`} onClick={() => save({ excludedPaths: s.excludedPaths.filter(x => x !== p) })}><Icon name="close" size={13} /></button></span>) : <span className="fine">None.</span>}
            </div>
            <div className="add-row"><input value={path} onChange={e => setPath(e.target.value)} placeholder="/Users/you/Private" aria-label="Folder to exclude"
              onKeyDown={e => { if (e.key === 'Enter' && path.trim()) { save({ excludedPaths: [...s.excludedPaths, path.trim()] }, 'Folder excluded.'); setPath(''); } }} />
              <button className="btn btn-line" disabled={!path.trim()} onClick={() => { save({ excludedPaths: [...s.excludedPaths, path.trim()] }, 'Folder excluded.'); setPath(''); }}>Exclude</button></div>
          </div>
        </Setting>
        <Setting title="Never collected" text="Screenshots, keystrokes, clipboard, document or page content, audio, browser history. There is no code for these in WorkNEX.">
          <span className="chip chip-local"><Icon name="lock" size={13} />By design</span>
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>History</p>
      <div className="settings">
        <Setting title="Keep work history" text="Contexts older than this are deleted automatically. Raw activity is never written to disk — it stays in memory for an hour at most.">
          <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
            <Segmented options={['7', '30', '90', 'custom'] as const} value={[7, 30, 90].includes(s.retentionDays) ? String(s.retentionDays) as '7' | '30' | '90' : 'custom'}
              label={v => (v === 'custom' ? 'Custom' : `${v} days`)} onChange={v => v !== 'custom' && save({ retentionDays: Number(v) }, `Keeping ${v} days of work history.`)} />
            {![7, 30, 90].includes(s.retentionDays) && <span className="fine" style={{ margin: 0 }}>Currently {s.retentionDays} days</span>}
            <div className="add-row"><input value={custom} onChange={e => setCustom(e.target.value.replace(/\D/g, ''))} placeholder="Days (1–365)" aria-label="Custom retention days" style={{ maxWidth: 140 }} />
              <button className="btn btn-line" disabled={!custom} onClick={() => { save({ retentionDays: Number(custom) }, `Keeping ${custom} days of work history.`); setCustom(''); }}>Set</button></div>
          </div>
        </Setting>
        <Setting title="Clear work history" text="Deletes WorkNEX contexts and timeline from this computer. MemNEX, DevNEX projects, your files and Git repositories are not affected.">
          <button className="btn btn-line" onClick={() => setClearing(true)}>Clear history…</button>
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Resume</p>
      <div className="settings">
        <Setting title="Confirm before opening resources" text="Show the Resume preview so you choose what opens. Turn off to open the default selection directly.">
          <Switch on={s.confirmBeforeOpen} label="Confirm before opening" onChange={v => save({ confirmBeforeOpen: v })} />
        </Setting>
        <Setting title="Default resume actions" text="Pre-selected in the Resume preview. You can still change them each time.">
          <div style={{ display: 'grid', gap: 4, minWidth: 280 }}>
            {Object.keys(RESUME_LABEL).map(k => (
              <label key={k} className="toggle-row"><span>{RESUME_LABEL[k]}</span>
                <Switch on={s.defaultResume[k as keyof WorknexSettings['defaultResume']]} label={RESUME_LABEL[k]} onChange={v => save({ defaultResume: { ...s.defaultResume, [k]: v } })} /></label>
            ))}
          </div>
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Module</p>
      <div className="settings">
        <Setting title="Status" text={!status.trackedApps ? 'Not configured — no applications are tracked, nothing is collected.' : status.paused ? 'Paused.' : status.detection === 'full' ? `Collecting · sampling every ${data.sampleSeconds} s · ${data.rawInMemory} raw samples in memory (never on disk).` : status.detectionDetail ?? 'Limited detection.'}>
          <Pill tone={!status.trackedApps ? 'muted' : status.paused ? 'warn' : status.detection === 'full' ? 'ok' : 'warn'}>{!status.trackedApps ? 'Not configured' : status.paused ? 'Paused' : status.detection === 'full' ? `Tracking ${status.trackedApps} app${status.trackedApps === 1 ? '' : 's'}` : 'Limited'}</Pill>
        </Setting>
        <Setting title="WorkNEX" text="Work Continuity Intelligence · local-first · stored as small JSON files in apps/workbench-api/.worknex">
          <span className="fine" style={{ margin: 0 }}>v0.3.0</span>
        </Setting>
      </div>

      {clearing && (
        <Modal onClose={() => setClearing(false)}>
          <p className="eyebrow tone-text-critical">Clear work history</p>
          <h2 className="h2">Delete your WorkNEX history?</h2>
          <p>All work contexts and the timeline on this computer are deleted. This can’t be undone. MemNEX, DevNEX, files and Git repositories are not touched.</p>
          <label className="resume-item" style={{ marginTop: 12 }}><input type="checkbox" checked={includeSaved} onChange={e => setIncludeSaved(e.target.checked)} /><span><b>Also delete save points</b><small>Your saved contexts are kept unless you tick this.</small></span></label>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setClearing(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={clear}>Delete history</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ───────────────────────── Tracked applications (the allowlist) ───────────────────────── */
const LEVELS: { value: TrackingLevel; label: string; text: string }[] = [
  { value: 1, label: 'Presence', text: 'App name and time only' },
  { value: 2, label: 'Context', text: '+ window titles and project/folder' },
  { value: 3, label: 'Extended', text: '+ file names (browsers: tab titles)' },
];

/** In a browser the window title IS the tab title, so titles start at Extended. */
const BROWSER_LEVEL_TEXT = ['Browser name and time only', '+ project via localhost ports (no tab titles)', '+ tab titles (URLs: separate switch)'];

function TrackedApps({ setToast, onChanged }: { setToast: (t: Toasty) => void; onChanged: () => void }) {
  const [apps, setApps] = useState<TrackedApplication[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TrackedApplication | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  const load = useCallback(() => get<TrackedApplication[]>('/tracked-apps').then(setApps).catch(() => setApps([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (params.get('add') === '1') { setAdding(true); router.replace('/worknex/settings'); } }, [params, router]);
  const update = async (a: TrackedApplication, patch: { level?: TrackingLevel; url?: boolean; enabled?: boolean }, text?: string) => {
    try { await call('PUT', `/tracked-apps/${a.id}`, patch); if (text) setToast({ tone: 'ok', text }); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    load(); onChanged();
  };
  const remove = async (a: TrackedApplication, deleteHistory: boolean) => {
    try {
      await call('DELETE', `/tracked-apps/${a.id}?deleteHistory=${deleteHistory}`);
      setToast({ tone: 'ok', text: deleteHistory ? `Stopped tracking ${a.displayName} and deleted its WorkNEX history.` : `Stopped tracking ${a.displayName}. Existing history kept.` });
    } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    setRemoving(null); load(); onChanged();
  };
  return (
    <>
      <div className="tile-head" style={{ marginTop: 4, marginBottom: 10 }}>
        <div><p className="eyebrow" style={{ margin: 0 }}>Tracked applications</p><p className="fine" style={{ marginTop: 2 }}>Only these apps participate in WorkNEX. Every other app is ignored and never saved.</p></div>
        <button className="btn btn-ink" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add application</button>
      </div>
      <div className="table">
        {!apps ? <EmptyState title="Loading…" /> : !apps.length ? (
          <EmptyState title="WorkNEX is not tracking any applications.">Add only the applications you want WorkNEX to use for work continuity.</EmptyState>
        ) : apps.map(a => (
          <div className="tracked-row" key={a.id}>
            <span className="cell-app" style={{ minWidth: 0 }}>
              <span className="app-icon"><Icon name="overview" size={16} /></span>
              <span style={{ minWidth: 0 }}><b>{a.displayName}</b><small className="mono" title={a.applicationId}>{a.applicationId}</small></span>
            </span>
            <span>{a.enabled ? <Pill tone="ok">Tracking</Pill> : <Pill tone="muted">Not tracked</Pill>}</span>
            <span style={{ display: 'grid', gap: 4 }}>
              <Segmented options={['1', '2', '3'] as const} value={String(a.level) as '1' | '2' | '3'} label={v => LEVELS[Number(v) - 1].label}
                onChange={v => update(a, { level: Number(v) as TrackingLevel }, `${a.displayName}: ${LEVELS[Number(v) - 1].label}.`)} />
              <small className="fine" style={{ margin: 0 }}>{a.kind === 'browser' ? BROWSER_LEVEL_TEXT[a.level - 1] : LEVELS[a.level - 1].text}</small>
            </span>
            <span>
              {a.kind === 'browser'
                ? <label className="toggle-row" title={a.level < 2 ? 'Needs Context or Extended' : ''}><span className="fine" style={{ margin: 0 }}>URLs</span><Switch on={a.permissions.url} label={`Track URLs in ${a.displayName}`} onChange={v => update(a, { url: v, ...(v && a.level < 2 ? { level: 2 as TrackingLevel } : {}) }, v ? `${a.displayName}: URLs will be recorded.` : `${a.displayName}: URLs off.`)} /></label>
                : <span className="fine" style={{ margin: 0 }}>URLs n/a</span>}
            </span>
            <span className="cell-actions">
              <Switch on={a.enabled} label={`${a.displayName} enabled`} onChange={v => update(a, { enabled: v }, v ? `Tracking ${a.displayName} again.` : `${a.displayName} is not tracked (kept in your list).`)} />
              <button className="btn btn-line" onClick={() => setRemoving(a)}>Stop tracking…</button>
            </span>
          </div>
        ))}
      </div>
      {adding && <AddAppsDialog onClose={() => setAdding(false)} onAdded={n => { setAdding(false); setToast({ tone: 'ok', text: `WorkNEX now tracks ${n} app${n === 1 ? '' : 's'} (Presence level — raise it per app if you want more context).` }); load(); onChanged(); }} setToast={setToast} />}
      {removing && (
        <Modal onClose={() => setRemoving(null)}>
          <p className="eyebrow">Stop tracking</p>
          <h2 className="h2">Stop tracking {removing.displayName}?</h2>
          <p>WorkNEX stops observing {removing.displayName} immediately. What should happen to the WorkNEX history it already contributed?</p>
          <p className="fine">Deleting removes it from WorkNEX contexts and save points only — not your files, app data, browser history, DevNEX or MemNEX.</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn-line" onClick={() => remove(removing, false)}>Keep existing history</button>
            <button className="btn btn-danger" onClick={() => remove(removing, true)}>Remove app &amp; delete history</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Discovery is not consent: nothing is pre-selected and there is no "select all". */
function AddAppsDialog({ onClose, onAdded, setToast }: { onClose: () => void; onAdded: (n: number) => void; setToast: (t: Toasty) => void }) {
  const [apps, setApps] = useState<AvailableApplication[] | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<AvailableApplication[]>('/available-apps').then(setApps).catch(e => { setApps([]); setToast({ tone: 'error', text: (e as Error).message }); }); }, [setToast]);
  const list = (apps ?? []).filter(a => !a.tracked && (!query || a.displayName.toLowerCase().includes(query.toLowerCase())));
  const groups: [string, AvailableApplication[]][] = [['Currently running', list.filter(a => a.running)], ['Installed', list.filter(a => !a.running)]];
  const add = async () => {
    setBusy(true);
    let n = 0;
    for (const a of (apps ?? []).filter(x => chosen.includes(x.applicationId))) {
      try { await post(`${API}/tracked-apps`, { applicationId: a.applicationId, displayName: a.displayName, bundleId: a.bundleId, executable: a.executable }); n++; }
      catch (e) { setToast({ tone: 'error', text: `${a.displayName}: ${(e as Error).message}` }); }
    }
    setBusy(false);
    onAdded(n);
  };
  return (
    <Modal onClose={onClose} busy={busy}>
      <div className="modal-wide">
        <p className="eyebrow">Add applications</p>
        <h2 className="h2">Choose applications WorkNEX may track</h2>
        <p>Only the apps you tick are observed. New apps start at <b>Presence</b> (name and time only).</p>
        <div style={{ marginTop: 12 }}><SearchField value={query} onChange={setQuery} placeholder="Search apps…" /></div>
        <ul className="resume-list">
          {!apps ? <li className="empty">Looking for applications…</li> : !list.length ? <li className="empty">No apps match.</li> : groups.map(([label, items]) => items.length ? (
            <Fragment key={label}>
              <li><p className="palette-group" style={{ padding: '10px 0 4px' }}>{label}</p></li>
              {items.map(a => (
                <li key={a.applicationId}>
                  <label className="resume-item">
                    <input type="checkbox" checked={chosen.includes(a.applicationId)} onChange={() => setChosen(c => (c.includes(a.applicationId) ? c.filter(x => x !== a.applicationId) : [...c, a.applicationId]))} />
                    <span><b>{a.displayName}</b><small>{a.sensitive ? 'Private conversations or passwords may appear in its titles — Presence level recommended' : a.bundleId ?? a.executable}</small></span>
                  </label>
                </li>
              ))}
            </Fragment>
          ) : null)}
        </ul>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-ink" onClick={add} disabled={busy || !chosen.length}>{busy ? 'Adding…' : `Track ${chosen.length || ''} app${chosen.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────── Dialogs ───────────────────────── */
function WhereDialog({ where, now, onClose, onResume }: { where: Where; now: number; onClose: () => void; onResume: (c: WorkContext) => void }) {
  return (
    <Modal onClose={onClose}>
      <p className="eyebrow">Where was I?</p>
      {where ? <>
        <h2 className="h2">{where.isActive ? 'You’re working on' : 'You were working on'}</h2>
        <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', margin: '6px 0 0' }}>{where.context.title}{where.context.subtitle ? ` — ${where.context.subtitle}` : ''}</p>
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>Last active</dt><dd>{where.isActive ? 'now' : since(where.context.lastActiveAt, now)}</dd>
          {where.recentFile && <><dt>Recent activity</dt><dd>{where.recentFile}</dd></>}
          {!!where.related.length && <><dt>Related</dt><dd>{where.related.join(', ')}</dd></>}
          {where.context.gitBranch && <><dt>Branch</dt><dd>{where.context.gitBranch}</dd></>}
        </dl>
        {where.changedWhen && <p>{where.changedWhen}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <Link className="btn btn-line" href={`/worknex/contexts/${where.context.id}`} onClick={onClose}>Details</Link>
          <button className="btn btn-ink" onClick={() => onResume(where.context)}>Resume…</button>
        </div>
      </> : <>
        <h2 className="h2">Nothing to go back to yet.</h2>
        <p>Once you’ve spent a few minutes on a project or document, WorkNEX can bring you back to it.</p>
        <div className="modal-actions"><button className="btn btn-ink" onClick={onClose}>OK</button></div>
      </>}
    </Modal>
  );
}

function SaveDialog({ target, onClose, onSaved, setToast }: { target: WorkContext | 'current'; onClose: () => void; onSaved: (s: SavedContext) => void; setToast: (t: Toasty) => void }) {
  const [ctx, setCtx] = useState<WorkContext | null>(target === 'current' ? null : target);
  const [label, setLabel] = useState(target === 'current' ? '' : target.title + (target.subtitle ? ` — ${target.subtitle}` : ''));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (target !== 'current') return;
    get<WorkContext[]>('/recent?limit=1').then(r => { if (r[0]) { setCtx(r[0]); setLabel(r[0].title + (r[0].subtitle ? ` — ${r[0].subtitle}` : '')); } }).catch(() => {});
  }, [target]);
  const save = async () => {
    if (!ctx) return;
    setBusy(true);
    try { onSaved(await post<SavedContext>(`${API}/contexts/${ctx.id}/save`, { label, note })); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); setBusy(false); }
  };
  return (
    <Modal onClose={onClose} busy={busy}>
      <div className="modal-wide">
        <p className="eyebrow">Save work context</p>
        {!ctx ? <><h2 className="h2">Nothing to save yet.</h2><p>WorkNEX needs a few seconds of activity first.</p><div className="modal-actions"><button className="btn btn-ink" onClick={onClose}>OK</button></div></> : <>
          <h2 className="h2">{ctx.title}</h2>
          <p>Detected: {[`${ctx.applications.length} application${ctx.applications.length === 1 ? '' : 's'}`, ctx.projectPath && 'a project folder', ctx.files.length && `${ctx.files.length} related file${ctx.files.length === 1 ? '' : 's'}`, ctx.gitBranch && `branch ${ctx.gitBranch}`].filter(Boolean).join(' · ')}</p>
          <label className="field">Label<input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} /></label>
          <label className="field">Note (optional)<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} placeholder="Where you stopped, what’s next…" /></label>
          <p className="fine">A save point keeps references (folders, files, local URLs, apps). It doesn’t capture app windows or unsaved work.</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-ink" onClick={save} disabled={busy || !label.trim()}>{busy ? 'Saving…' : 'Save context'}</button>
          </div>
        </>}
      </div>
    </Modal>
  );
}

/** Explain first, act second: list what would open; the user unticks anything; only selected items open. */
function ResumeDialog({ target, onClose, onDone, setToast }: { target: ResumeTarget; onClose: () => void; onDone: (r: ResumeResult, routes: string[]) => void; setToast: (t: Toasty) => void }) {
  const [plan, setPlan] = useState<(ResumePlan & { confirmBeforeOpen: boolean }) | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (ids: string[]) => {
    setBusy(true);
    try { const r = await post<ResumeResult>(`${API}/${target.source}/${target.id}/resume`, { itemIds: ids, confirmed: true }); onDone(r, r.routes); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); setBusy(false); }
  }, [target, onDone, setToast]);
  useEffect(() => {
    post<ResumePlan & { confirmBeforeOpen: boolean }>(`${API}/${target.source}/${target.id}/resume-preview`, {})
      .then(p => {
        const defaults = p.items.filter(i => i.selected && !i.unavailable).map(i => i.id);
        if (!p.confirmBeforeOpen && defaults.length) return run(defaults);
        setPlan(p); setSelected(defaults);
      })
      .catch(e => setError((e as Error).message));
  }, [target, run]);
  const toggle = (id: string) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  return (
    <Modal onClose={onClose} busy={busy}>
      <div className="modal-wide">
        <p className="eyebrow">Resume</p>
        <h2 className="h2">Resume {target.title}</h2>
        {error ? <p className="tone-text-critical">{error}</p> : !plan ? <p>Preparing…</p> : !plan.items.length ? (
          <p>There’s nothing WorkNEX can reopen for this context — no project folder, files or local services were seen.</p>
        ) : <>
          <p>Will open:</p>
          <ul className="resume-list">
            {plan.items.map(i => (
              <li key={i.id}>
                <label className={`resume-item ${i.unavailable ? 'is-off' : ''}`}>
                  <input type="checkbox" checked={selected.includes(i.id)} disabled={!!i.unavailable} onChange={() => toggle(i.id)} />
                  <span><b>{i.label}</b><small title={i.detail}>{i.unavailable ? `${i.unavailable} · ${i.detail}` : i.detail}</small></span>
                </label>
              </li>
            ))}
          </ul>
          <p className="fine">Apps open fresh — WorkNEX reopens folders, files and pages, not previous windows or unsaved work.</p>
        </>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {plan && !!plan.items.length && <button className="btn btn-ink" onClick={() => run(selected)} disabled={busy || !selected.length}>{busy ? 'Opening…' : `Resume${selected.length ? ` (${selected.length})` : ''}`}</button>}
        </div>
      </div>
    </Modal>
  );
}

