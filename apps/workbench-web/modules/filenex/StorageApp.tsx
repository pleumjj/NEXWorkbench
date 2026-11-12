'use client';
/* FileNEX › Storage — Know where your space went. Analyze first. Delete deliberately (FileNEX never deletes). */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { CleanupCandidate, CleanupRisk, DiskVolume, DockerStorage, DuplicateGroup, RepositoryStorage, StorageEntry, StorageForecast, StorageHealth, StorageSettings } from '@nex/filenex';
import { EmptyState, FilterChips, Icon, Meter, Modal, Pill, SearchField, Segmented, Setting, Stat, createPost, since, useNow } from '@nex/ui';

/* ───────────────────────── API & helpers ───────────────────────── */
const API = '/api/filenex/storage';
const post = createPost('FileNEX');
async function call<T>(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let r: Response;
  try { r = await fetch(`${API}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Lost connection to FileNEX’s local service. Run npm run dev again.'); }
  const text = await r.text().catch(() => '');
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (!r.ok) throw new Error(j?.message ?? `HTTP ${r.status}`);
  return j as T;
}
const get = <T,>(path: string) => call<T>('GET', path);

const KB = 1024, MB = 1024 ** 2, GB = 1024 ** 3, TB = 1024 ** 4;
/** Bytes → "8.4 GB" / "720 MB" / "12 KB". */
export const fb = (n: number | null | undefined) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  return a >= TB ? `${(n / TB).toFixed(2)} TB` : a >= GB ? `${(n / GB).toFixed(1)} GB` : a >= MB ? `${Math.round(n / MB)} MB` : a >= KB ? `${Math.round(n / KB)} KB` : `${n} B`;
};
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${fb(Math.abs(n))}`;
const nf = (n: number) => n.toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const daysAgo = (iso: string | null, now: number) => { if (!iso) return '—'; const d = Math.floor((now - Date.parse(iso)) / 86_400_000); return d < 1 ? 'Today' : d < 2 ? 'Yesterday' : d < 60 ? `${d} days ago` : new Date(iso).toLocaleDateString(); };
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
/** Keep the start and the end of a long path readable: "~/Documents/TOPO/…/agent-a00dc7b2…/frontend/node_modules". */
const midPath = (p: string, max = 70) => {
  const s = shortPath(p);
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.35)), tail = s.slice(s.length - Math.ceil(max * 0.6));
  return `${head.replace(/[^/\\]*$/, '')}…${tail.slice(tail.search(/[/\\]/))}`;
};

type Toasty = { tone: 'ok' | 'error'; text: string };
type Health = { status: StorageHealth; reasons: string[] } | null;
type Status = {
  enabled: boolean; paused: boolean; state: 'disabled' | 'paused' | 'scanning' | 'updating' | 'deferred' | 'queued' | 'idle'; deferredReason: string | null;
  progress: { label: string; entries: number; reposDone: number; reposTotal: number; index: number; of: number } | null; queued: number; lastAnalyzedAt: string | null;
  locations: { id: string; label: string; path: string; paused: boolean; analyzedAt: string | null; totalBytes: number | null; truncated: boolean }[]; configured: boolean;
  history: { snapshots: number; repoSnapshots: number; analyses: number };
};
type Growth = { days: number; from: string; to: string; usedDeltaBytes: number; breakdown: { key: string; label: string; kind: string; deltaBytes: number }[]; otherDeltaBytes: number; attributed: boolean } | null;
type DistItem = { key: string; label: string; kind: string; bytes: number; estimate: boolean; note: string; folders: { key: string; label: string; bytes: number }[] };
type Overview = {
  volume: DiskVolume | null; volumes: DiskVolume[]; health: Health; forecast: StorageForecast; growth: Growth;
  distribution: { usedBytes: number; analyzedBytes: number; items: DistItem[]; notAnalyzedBytes: number } | null;
  recovery: { totalBytes: number; groups: { group: string; label: string; bytes: number; count: number }[] }; docker: DockerStorage | null; status: Status; devTotalBytes: number;
};
type FootGroup = { label: string; bytes: number; repos: { projectId: string; name: string; bytes: number }[] };
type Dev = {
  enabled: boolean; sharedEnabled: boolean; docker: DockerStorage | null; status: Status; repos: RepositoryStorage[];
  growth: { projectId: string; name: string; growth7dBytes: number | null }[];
  summary: { totalBytes: number; repositories: number; unavailable: number; recoverableBytes: number; gitBytes: number; dependencies: { totalBytes: number; groups: FootGroup[] }; buildCache: { totalBytes: number; groups: FootGroup[] }; shared: { id: string; label: string; path: string; bytes: number | null; measuredAt: string | null; clean: string; insideApprovedLocation: boolean }[] };
};
type RepoDetail = { repo: RepositoryStorage; git: { isRepo: boolean; branch: string | null; changed: number; untracked: number } | null; growth: { from: string; to: string; fromBytes: number; toBytes: number; deltaBytes: number; parts: { key: string; label: string; deltaBytes: number }[] } | null; old: boolean; gitClean: boolean | null; inactiveThresholdDays: number };

const RISK: Record<CleanupRisk, { tone: string; label: string; lock?: boolean }> = {
  SAFE_TO_REVIEW: { tone: 'ok', label: 'Safe to review' },
  REVIEW_CAREFULLY: { tone: 'warn', label: 'Review carefully' },
  PROTECTED: { tone: 'protected', label: 'Protected', lock: true },
};
const RiskPill = ({ risk }: { risk: CleanupRisk }) => <Pill tone={RISK[risk].tone} lock={RISK[risk].lock}>{RISK[risk].label}</Pill>;
const HEALTH: Record<StorageHealth, { word: string; tone: string; meter: string }> = {
  healthy: { word: 'Healthy', tone: 'healthy', meter: 'healthy' }, attention: { word: 'Attention', tone: 'moderate', meter: 'moderate' },
  low: { word: 'Low', tone: 'high', meter: 'high' }, critical: { word: 'Critical', tone: 'critical', meter: 'critical' },
};
const CATEGORY_TEXT: Record<string, { label: string; text: string }> = {
  source: { label: 'Source & configuration', text: 'Code, config, docs, lockfiles and .env files the project is made of. Protected.' },
  dependencies: { label: 'Dependencies', text: 'node_modules, virtualenvs, vendor. Regeneratable by reinstalling — but removing them interrupts work until you do.' },
  build: { label: 'Build output', text: '.next, dist, build, out, target. Re-created by building the project.' },
  cache: { label: 'Caches', text: 'Turbo, Nx, tool caches, coverage. Rebuilt automatically when needed.' },
  logs: { label: 'Logs', text: 'Log folders and *.log files. Old logs are worth reviewing; recent ones may be needed.' },
  git: { label: 'Git', text: 'The repository history (.git). Visible, never suggested for cleanup.' },
  other: { label: 'Other', text: 'Assets, media, data and anything not classified. Protected.' },
};

export const STORAGE_TABS = [
  { slug: '', label: 'Overview' }, { slug: 'large-files', label: 'Large Files' }, { slug: 'developer', label: 'Developer Storage' },
  { slug: 'duplicates', label: 'Duplicates' }, { slug: 'growth', label: 'Growth' }, { slug: 'cleanup', label: 'Cleanup Review' },
] as const;
export const storageTabLabel = (slug: string) => STORAGE_TABS.find(t => t.slug === slug)?.label ?? 'Overview';

/* ───────────────────────── Shell ───────────────────────── */
export function StoragePage({ tab, id, setToast }: { tab: string; id: string | null; setToast: (t: Toasty) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [rev, setRev] = useState(0);
  const loadStatus = useCallback(() => get<Status>('/status').then(setStatus).catch(() => {}), []);
  const busy = status?.state === 'scanning' || status?.state === 'updating' || status?.state === 'queued';
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, busy ? 2000 : 10_000); return () => clearInterval(t); }, [loadStatus, busy]);
  // When an analysis finishes, reload the page data.
  const [wasBusy, setWasBusy] = useState(false);
  useEffect(() => { if (wasBusy && !busy) setRev(r => r + 1); setWasBusy(busy); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>, text: string) => { try { await fn(); setToast({ tone: 'ok', text }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } loadStatus(); };

  return (
    <>
      <nav className="chips st-tabs" aria-label="Storage">
        {STORAGE_TABS.map(t => <Link key={t.slug} href={`/filenex/storage${t.slug ? `/${t.slug}` : ''}`} className={`chip ${tab === t.slug ? 'on' : ''}`} aria-current={tab === t.slug ? 'page' : undefined}>{t.label}</Link>)}
      </nav>
      {status && <AnalysisLine status={status} onScan={() => act(() => post(`${API}/scan`, {}), 'Analyzing storage in your approved folders…')} onPause={() => act(() => post(`${API}/pause`, {}), 'Storage analysis paused.')} onResume={() => act(() => post(`${API}/resume`, {}), 'Storage analysis resumed.')} />}
      {tab === '' && <StorageOverview rev={rev} />}
      {tab === 'large-files' && <LargeFiles rev={rev} setToast={setToast} />}
      {tab === 'developer' && (id ? <RepoDetailPage id={id} rev={rev} setToast={setToast} /> : <Developer rev={rev} setToast={setToast} />)}
      {tab === 'duplicates' && <StorageDuplicates />}
      {tab === 'growth' && <GrowthPage rev={rev} />}
      {tab === 'cleanup' && <CleanupReview rev={rev} setToast={setToast} />}
    </>
  );
}

function AnalysisLine({ status, onScan, onPause, onResume }: { status: Status; onScan: () => void; onPause: () => void; onResume: () => void }) {
  const now = useNow(5000);
  const p = status.progress;
  const word = { disabled: 'Off', paused: 'Paused', scanning: 'Scanning', updating: 'Updating', deferred: 'Waiting', queued: 'Queued', idle: 'Idle' }[status.state];
  return (
    <div className="fx-statusline">
      <span>Storage analysis <b>{word}</b></span>
      {p ? <span className="live"><i />Analyzing {p.label} · {nf(p.entries)} items{p.reposTotal ? ` · ${p.reposDone} / ${p.reposTotal} repositories` : ''}{p.of > 1 ? ` · folder ${p.index} of ${p.of}` : ''}</span>
        : status.state === 'deferred' ? <span>{status.deferredReason}</span>
        : status.lastAnalyzedAt ? <span>Last analyzed {since(status.lastAnalyzedAt, now)}</span> : status.configured ? <span>Not analyzed yet</span> : <span>No approved folders — only disk capacity is shown</span>}
      <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        {status.state === 'paused' ? <button className="btn btn-ghost btn-sm" onClick={onResume}><Icon name="play" size={12} />Resume</button>
          : status.enabled && status.configured && <>
            <button className="btn btn-ghost btn-sm" onClick={onScan} disabled={!!p}><Icon name="refresh" size={12} />Analyze now</button>
            <button className="btn btn-ghost btn-sm" onClick={onPause}><Icon name="pause" size={12} />Pause</button>
          </>}
        {status.state === 'disabled' && <Link className="btn btn-ghost btn-sm" href="/filenex/settings#storage">Turn on in Settings</Link>}
      </span>
    </div>
  );
}

function NoFolders({ what }: { what: string }) {
  return (
    <div className="notice"><Icon name="lock" size={16} /><div><b>No folder permission, no scanning.</b>{what} FileNEX only analyzes folders you add. <Link className="chip-action" href="/filenex/settings?add=1">Add a folder</Link></div></div>
  );
}

/** A labelled horizontal bar row (name · bar · size). */
function Bar({ label, sub, bytes, max, tone, right }: { label: React.ReactNode; sub?: React.ReactNode; bytes: number; max: number; tone?: string; right?: React.ReactNode }) {
  return (
    <div className="st-row">
      <span className="st-label"><b>{label}</b>{sub && <small>{sub}</small>}</span>
      <span className="bar"><i className={tone ? `tone-bg-${tone}` : ''} style={{ width: `${Math.max(1, Math.min(100, pct(bytes, max)))}%` }} /></span>
      <strong className="num">{right ?? fb(bytes)}</strong>
    </div>
  );
}

/* ───────────────────────── Overview ───────────────────────── */
function StorageOverview({ rev }: { rev: number }) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<Overview>('/overview').then(x => { setO(x); setError(null); }).catch(e => setError((e as Error).message)); }, [rev]);
  if (error) return <EmptyState title="Storage overview unavailable">{error}</EmptyState>;
  if (!o) return <EmptyState title="Reading disk usage…" />;
  const v = o.volume;
  if (!v || !o.health) return <EmptyState title="Disk information is not available on this system." />;
  const h = HEALTH[o.health.status];
  const used = pct(v.usedBytes, v.totalBytes);
  const dist = o.distribution;
  const maxItem = Math.max(1, ...(dist?.items.map(i => i.bytes) ?? []), dist?.notAnalyzedBytes ?? 0);
  return (
    <>
      <div className="bento">
        <article className={`tile tile-health tone-${h.tone}`}>
          <p className="eyebrow">Storage · {v.label}</p>
          <h2 className="state-word">{h.word}</h2>
          <p className="insight-headline">{fb(v.freeBytes)} free of {fb(v.totalBytes)}.</p>
          <p className="insight-detail">{o.health.reasons.slice(1).join(' ') || 'Enough free space for normal use.'}{o.forecast.enough && o.forecast.weeksTo90 != null ? ` ${o.forecast.message}` : ''}</p>
          <ul className="evidence">
            <li>{used.toFixed(0)}% used</li>
            {o.growth && <li>{signed(o.growth.usedDeltaBytes)} in 7 days</li>}
            {o.recovery.totalBytes > 0 && <li>{fb(o.recovery.totalBytes)} potentially recoverable</li>}
          </ul>
          <div className="tile-foot">
            {o.recovery.totalBytes > 0 ? <Link className="btn btn-ink" href="/filenex/storage/cleanup">Review cleanup <Icon name="arrow" size={16} /></Link>
              : o.status.configured ? <Link className="btn btn-ink" href="/filenex/storage/large-files">Large files <Icon name="arrow" size={16} /></Link>
              : <Link className="btn btn-ink" href="/filenex/settings?add=1">Add a folder to analyze <Icon name="arrow" size={16} /></Link>}
          </div>
        </article>
        <article className="tile tile-memory">
          <p className="eyebrow">Used</p>
          <p className="big-num">{(v.usedBytes / GB).toFixed(0)}<span> / {(v.totalBytes / GB).toFixed(0)} GB</span></p>
          <Meter value={used} tone={h.meter} label={`${used.toFixed(0)}% used`} ticks={[80, 90]} />
          <dl className="signals">
            <div className={`signal ${o.health.status === 'healthy' ? 'signal-ok' : o.health.status === 'attention' ? 'signal-warn' : 'signal-bad'}`}><dt>Free</dt><dd><i />{fb(v.freeBytes)}</dd></div>
            <div className="signal signal-ok"><dt>Developer storage</dt><dd><i />{o.devTotalBytes ? fb(o.devTotalBytes) : '—'}</dd></div>
            <div className={`signal ${o.docker?.available ? 'signal-ok' : 'signal-warn'}`}><dt>Docker</dt><dd><i />{o.docker?.available ? fb(o.docker.images.bytes + o.docker.containers.bytes + o.docker.volumes.bytes + o.docker.buildCache.bytes) : o.docker ? 'Not running' : 'Off'}</dd></div>
          </dl>
          <p className="fine" style={{ marginBottom: 0 }}>Reported by the operating system. On macOS, purgeable space is not counted as free.</p>
        </article>
        <Stat label="Potentially recoverable" value={o.status.configured ? fb(o.recovery.totalBytes) : '—'} detail={o.status.configured ? 'Review opportunities, not guaranteed' : 'Add folders to analyze'} />
        <Stat label="Last 7 days" value={o.growth ? signed(o.growth.usedDeltaBytes) : '—'} detail={o.growth ? 'Change in used space' : 'Building history…'} warn={!!o.growth && o.growth.usedDeltaBytes > 10 * GB} />
        <Stat label="Forecast" value={o.forecast.enough && o.forecast.ratePerWeekBytes != null ? `${signed(o.forecast.ratePerWeekBytes)}/wk` : '—'} detail={o.forecast.message} />
      </div>

      {!o.status.configured && <div style={{ marginTop: 12 }}><NoFolders what="Disk capacity needs no permission, but seeing what uses the space does." /></div>}

      <div className="bento" style={{ marginTop: 12 }}>
        <article className="tile span-7">
          <div className="tile-head"><div><p className="eyebrow">Where your space went</p><h3>{dist && dist.items.length ? `${fb(dist.analyzedBytes)} of ${fb(dist.usedBytes)} analyzed` : 'Not analyzed yet'}</h3></div></div>
          {dist && dist.items.length ? <>
            {dist.items.map(i => (
              <Fragment key={i.key}>
                <Bar label={i.label} sub={<>{i.note}{i.estimate && <> · <span className="pill pill-muted st-mini">Estimate</span></>}</>} bytes={i.bytes} max={maxItem} />
                {i.folders.filter(f => f.bytes >= i.bytes * 0.05).map(f => <div className="st-sub" key={f.key}><span>{f.label}</span><span className="num">{fb(f.bytes)}</span></div>)}
              </Fragment>
            ))}
            <Bar label="Not analyzed" sub="Apps, system, and folders outside FileNEX — not attributed" bytes={dist.notAnalyzedBytes} max={maxItem} tone="muted" />
            <p className="fine">Only folders you approved are measured exactly. Docker is as reported by Docker. FileNEX does not guess what is in the rest of the disk.</p>
          </> : <p className="fine">{o.status.configured ? 'The first analysis of your approved folders hasn’t finished yet.' : 'Approve a folder in Settings to see what uses space inside it.'}</p>}
        </article>
        <article className="tile span-5">
          <div className="tile-head"><div><p className="eyebrow">Potentially recoverable</p><h3>{fb(o.recovery.totalBytes)}</h3></div><Link className="btn btn-ghost" href="/filenex/storage/cleanup">Review <Icon name="arrow" size={16} /></Link></div>
          {o.recovery.groups.length ? <ul className="feed">{o.recovery.groups.map(g => <li key={g.group}><span>{g.label} <small className="fine" style={{ margin: 0 }}>· {g.count}</small></span><b className="num">{fb(g.bytes)}</b></li>)}</ul>
            : <p className="fine">Nothing to review yet. Candidates come from build output, caches, old logs, old downloads, duplicates and Docker.</p>}
          <p className="fine">Estimates for review. Source code, Git history, documents, photos, videos, .env files and databases are never included. FileNEX never deletes anything.</p>
        </article>
        {o.volumes.length > 1 && (
          <article className="tile span-12">
            <p className="eyebrow">Other volumes</p>
            {o.volumes.filter(x => !x.primary).map(x => <Bar key={x.path} label={x.label} sub={`${fb(x.freeBytes)} free`} bytes={x.usedBytes} max={x.totalBytes} right={`${fb(x.usedBytes)} / ${fb(x.totalBytes)}`} />)}
          </article>
        )}
      </div>
    </>
  );
}

/* ───────────────────────── Large files ───────────────────────── */
const THRESHOLDS = ['> 100 MB', '> 500 MB', '> 1 GB', '> 5 GB'] as const;
const TH_MB: Record<(typeof THRESHOLDS)[number], number> = { '> 100 MB': 100, '> 500 MB': 500, '> 1 GB': 1024, '> 5 GB': 5120 };
type LargeRow = { path: string; name: string; extension: string; bytes: number; modifiedAt: string; createdAt: string | null; inDownloads: boolean; locationLabel: string; risk: CleanupRisk; reason: string; fileId: string | null };

function LargeFiles({ rev, setToast }: { rev: number; setToast: (t: Toasty) => void }) {
  const now = useNow(60_000);
  const [th, setTh] = useState<(typeof THRESHOLDS)[number] | null>(null);
  const [sort, setSort] = useState<'largest' | 'oldest' | 'newest' | 'recent' | 'location'>('largest');
  const [res, setRes] = useState<{ thresholdMb: number; total: number; totalBytes: number; files: LargeRow[]; analyzedLocations: number } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams({ sort });
    if (th) p.set('min', String(TH_MB[th]));
    get<NonNullable<typeof res>>(`/large-files?${p}`).then(r => { setRes(r); if (!th) setTh((Object.keys(TH_MB) as (typeof THRESHOLDS)[number][]).find(k => TH_MB[k] === r.thresholdMb) ?? '> 1 GB'); }).catch(() => setRes(null));
  }, [th, sort, rev]);
  const act = async (what: 'open' | 'reveal', path: string) => { try { await post(`${API}/${what}`, { path }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } };
  if (!res) return <EmptyState title="Loading…" />;
  if (!res.analyzedLocations) return <NoFolders what="Large files are found inside approved folders." />;
  return (
    <>
      <div className="toolbar">
        <FilterChips options={THRESHOLDS} value={th ?? '> 1 GB'} onChange={setTh} />
        <label className="sort">Sort
          <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="Sort large files">
            <option value="largest">Largest</option><option value="oldest">Oldest</option><option value="newest">Newest</option><option value="recent">Recently added</option><option value="location">Location</option>
          </select>
        </label>
      </div>
      <p className="fine section-note">{res.total ? `${nf(res.total)} file${res.total === 1 ? '' : 's'} · ${fb(res.totalBytes)}` : 'No files above this size'} in your approved folders. Files inside node_modules, .git and build folders are counted under Developer Storage.</p>
      {res.files.length ? (
        <div className="table" role="table">
          <div className="tr th cols-large" role="row"><span>File</span><span className="r">Size</span><span>Modified</span><span>Classification</span><span /></div>
          {res.files.map(f => (
            <div className="tr cols-large row-wrap" role="row" key={f.path}>
              <span className="cell-app"><span className="app-icon"><Icon name="file" size={16} /></span><span><b title={f.name}>{f.name}</b><small title={f.path}>{shortPath(f.path)}</small></span></span>
              <span className="num r"><b>{fb(f.bytes)}</b></span>
              <span className="fine" style={{ margin: 0 }}>{daysAgo(f.modifiedAt, now)}</span>
              <span title={f.reason}><RiskPill risk={f.risk} /></span>
              <span className="cell-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => act('open', f.path)}>Open</button>
                <button className="btn btn-ghost btn-sm" onClick={() => act('reveal', f.path)}>Reveal</button>
                {f.fileId ? <Link className="btn btn-ghost btn-sm" href={`/filenex/files/${f.fileId}`}>Details</Link> : <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(f.path); setToast({ tone: 'ok', text: 'Path copied.' }); }}>Copy path</button>}
              </span>
            </div>
          ))}
        </div>
      ) : <div className="table"><EmptyState title="No large files above this size" /></div>}
    </>
  );
}

/* ───────────────────────── Developer storage ───────────────────────── */
const DEV_SORTS = [['largest', 'Largest'], ['recoverable', 'Most recoverable'], ['oldest-active', 'Oldest active'], ['dependencies', 'Highest dependency size'], ['build-cache', 'Highest build cache'], ['growth', 'Highest growth']] as const;
const UNAVAILABLE: Record<string, string> = {
  'not-approved': 'This repository is not included in FileNEX indexed locations.',
  partial: 'Only part of this repository is inside an approved folder.',
  pending: 'Inside an approved folder — waiting for the next analysis.',
  disabled: 'Analysis of DevNEX projects is turned off in Settings.',
};

function ActivityPill({ r, now }: { r: RepositoryStorage; now: number }) {
  if (r.runningServiceCount) return <Pill tone="ok">Active · {r.runningServiceCount} running</Pill>;
  if (r.recentlyUsed) return <Pill tone="ok">Used today</Pill>;
  if (r.isActiveProject) return <Pill tone="ok">Active project</Pill>;
  if (r.inactiveDays != null && r.inactiveDays >= 30) return <Pill tone="muted">Inactive {r.inactiveDays} days</Pill>;
  return r.lastActiveAt ? <Pill tone="muted">{daysAgo(r.lastActiveAt, now)}</Pill> : null;
}

function Developer({ rev, setToast }: { rev: number; setToast: (t: Toasty) => void }) {
  const now = useNow(60_000);
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<(typeof DEV_SORTS)[number][0]>('largest');
  const [d, setD] = useState<Dev | null>(null);
  const load = useCallback(() => get<Dev>(`/developer?${new URLSearchParams({ q, sort })}`).then(setD).catch(() => {}), [q, sort]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load, rev]);
  const enableShared = async () => { try { await call('PUT', '/settings', { sharedCaches: true }); setToast({ tone: 'ok', text: 'Measuring npm / pnpm / Yarn caches (size only)…' }); setTimeout(load, 4000); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } };
  if (!d) return <EmptyState title="Loading…" />;
  const avail = d.repos.filter(r => r.available), unavail = d.repos.filter(r => !r.available);
  const s = d.summary;
  if (!d.enabled) return <div className="notice"><Icon name="code" size={16} /><div><b>Developer Storage is off.</b>Turn on “Analyze DevNEX projects” in <Link className="chip-action" href="/filenex/settings#storage">Settings</Link>.</div></div>;
  return (
    <>
      <article className="tile" style={{ marginBottom: 12 }}>
        <dl className="facts">
          <div><dt>Total dev storage</dt><dd className="mid-num">{fb(s.totalBytes)}</dd></div>
          <div><dt>Repositories analyzed</dt><dd className="mid-num">{s.repositories}{s.unavailable ? <small className="fine" style={{ margin: 0 }}> · {s.unavailable} not analyzed</small> : null}</dd></div>
          <div><dt>Potentially recoverable</dt><dd className="mid-num">{fb(s.recoverableBytes)}</dd></div>
          <div><dt>Dependencies</dt><dd className="mid-num">{fb(s.dependencies.totalBytes)}</dd></div>
        </dl>
        <p className="fine" style={{ marginBottom: 0 }}>DevNEX knows where each repository is; FileNEX measures only those inside your approved folders. Nested projects and shared package stores are not counted twice.</p>
      </article>

      <div className="toolbar">
        <SearchField value={q} onChange={setQ} placeholder="Repository, or e.g. node_modules > 5GB" />
        <label className="sort">Sort
          <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="Sort repositories">{DEV_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
      </div>
      {avail.length ? (
        <div className="table st-scroll" role="table">
          <div className="tr th cols-repos" role="row"><span>Repository</span><span className="r">Total</span><span className="r">Source</span><span className="r">Dependencies</span><span className="r">Build / Cache</span><span className="r">Docker</span><span className="r">Other</span><span>Last active</span></div>
          {avail.map((r, i) => (
            <div className="tr cols-repos row-wrap st-link" role="row" key={r.projectId} onClick={() => router.push(`/filenex/storage/developer/${encodeURIComponent(r.projectId)}`)}>
              <span className="cell-app"><span className="st-rank">{i + 1}</span><span><Link href={`/filenex/storage/developer/${encodeURIComponent(r.projectId)}`} onClick={e => e.stopPropagation()}><b>{r.name}</b></Link><small>{r.nested ? 'Inside another project · ' : ''}{r.worktrees.length ? `${r.worktrees.length} worktree${r.worktrees.length > 1 ? 's' : ''} · ` : ''}{shortPath(r.path)}</small></span></span>
              <span className="num r"><b>{fb(r.totalBytes)}</b></span>
              <span className="num r">{fb(r.sourceBytes)}</span>
              <span className="num r">{fb(r.dependencyBytes)}</span>
              <span className="num r">{fb(r.buildBytes + r.cacheBytes)}</span>
              <span className="num r">{r.dockerRelatedBytes ? fb(r.dockerRelatedBytes) : '—'}</span>
              <span className="num r">{fb(r.otherBytes + r.logBytes + r.gitBytes)}</span>
              <span><ActivityPill r={r} now={now} /></span>
            </div>
          ))}
        </div>
      ) : <div className="table"><EmptyState title={q ? 'No repositories match' : 'No repositories analyzed yet'}>{q ? 'Try a name, or a filter like “node_modules > 1GB”, “build >= 500mb”, “total < 2gb”.' : 'DevNEX projects appear here once their folder is inside an approved FileNEX location and has been analyzed.'}</EmptyState></div>}
      <p className="fine">“Other” includes logs ({fb(avail.reduce((n, r) => n + r.logBytes, 0))}) and Git history ({fb(s.gitBytes)}). Docker data lives in Docker’s own disk image and is not part of the folder total.</p>

      {!!unavail.length && (
        <>
          <h3 className="section-title" style={{ marginTop: 24 }}>Storage analysis unavailable</h3>
          <div className="table">
            {unavail.map(r => (
              <div className="fx-row" key={r.projectId}>
                <span className="cell-app" style={{ minWidth: 0 }}><span className="app-icon"><Icon name="lock" size={15} /></span><span style={{ minWidth: 0 }}><b>{r.name}</b><small>{UNAVAILABLE[r.unavailableReason ?? 'not-approved']} · {shortPath(r.path)}</small></span></span>
                <span />
                {(r.unavailableReason === 'not-approved' || r.unavailableReason === 'partial') ? <Link className="btn btn-line btn-sm" href={`/filenex/settings?add=1&path=${encodeURIComponent(r.path)}`}>Allow folder</Link> : <span />}
              </div>
            ))}
          </div>
          <p className="fine">Registering a project in DevNEX does not give FileNEX permission. Nothing outside your approved folders is scanned.</p>
        </>
      )}

      <div className="bento" style={{ marginTop: 16 }}>
        <article className="tile span-6">
          <div className="tile-head"><div><p className="eyebrow">Dependency footprint</p><h3>{fb(s.dependencies.totalBytes)}</h3></div></div>
          {s.dependencies.groups.length ? s.dependencies.groups.map(g => (
            <div key={g.label} style={{ marginBottom: 10 }}>
              <Bar label={g.label} sub={`${g.repos.length} repositor${g.repos.length === 1 ? 'y' : 'ies'}`} bytes={g.bytes} max={s.dependencies.groups[0].bytes} />
              {g.repos.slice(0, 5).map(r => <div className="st-sub" key={r.projectId}><Link href={`/filenex/storage/developer/${encodeURIComponent(r.projectId)}`}>{r.name}</Link><span className="num">{fb(r.bytes)}</span></div>)}
            </div>
          )) : <p className="fine">No dependency folders found.</p>}
        </article>
        <article className="tile span-6">
          <div className="tile-head"><div><p className="eyebrow">Build &amp; cache</p><h3>{fb(s.buildCache.totalBytes)}</h3></div><Link className="btn btn-ghost" href="/filenex/storage/cleanup">Review <Icon name="arrow" size={16} /></Link></div>
          {s.buildCache.groups.length ? s.buildCache.groups.slice(0, 6).map(g => (
            <div key={g.label} style={{ marginBottom: 10 }}>
              <Bar label={g.label} sub={g.repos.slice(0, 3).map(r => r.name).join(', ') + (g.repos.length > 3 ? ` +${g.repos.length - 3}` : '')} bytes={g.bytes} max={s.buildCache.groups[0].bytes} />
            </div>
          )) : <p className="fine">No build output or caches found.</p>}
          <p className="fine">Regeneratable by building again — often the strongest place to recover space.</p>
        </article>
        <article className="tile span-6">
          <div className="tile-head"><div><p className="eyebrow">Shared developer storage</p><h3>Package manager caches</h3></div></div>
          {d.sharedEnabled ? <>
            {s.shared.map(c => <Bar key={c.id} label={c.label} sub={c.bytes == null ? 'Not found / not measured yet' : `${c.clean}${c.insideApprovedLocation ? ' · inside an approved folder' : ''}`} bytes={c.bytes ?? 0} max={Math.max(1, ...s.shared.map(x => x.bytes ?? 0))} right={c.bytes == null ? '—' : fb(c.bytes)} />)}
            <p className="fine">Shown separately and never added to repository totals (pnpm installs may hard-link into its store). Clear caches with the package manager, not by deleting files.</p>
          </> : <>
            <p className="fine" style={{ marginTop: 0 }}>npm, pnpm and Yarn keep shared caches outside your projects. They are not in your approved folders, so FileNEX doesn’t measure them unless you allow it — size only, no file names.</p>
            <button className="btn btn-line" onClick={enableShared}>Measure shared caches</button>
          </>}
        </article>
        <article className="tile span-6">
          <div className="tile-head"><div><p className="eyebrow">Docker storage</p><h3>{d.docker?.available ? fb(d.docker.images.bytes + d.docker.containers.bytes + d.docker.volumes.bytes + d.docker.buildCache.bytes) : 'Not available'}</h3></div></div>
          {d.docker?.available ? <>
            {([['Images', d.docker.images], ['Volumes', d.docker.volumes], ['Build cache', d.docker.buildCache], ['Containers', d.docker.containers]] as const).map(([l, b]) => <Bar key={l} label={l} sub={`${b.count} · ${fb(b.reclaimableBytes)} unused`} bytes={b.bytes} max={Math.max(1, d.docker!.images.bytes, d.docker!.volumes.bytes, d.docker!.buildCache.bytes)} />)}
            <p className="fine">Read from <code>docker system df</code>. FileNEX never runs docker prune.</p>
          </> : <p className="fine">{d.docker ? d.docker.detail : 'Docker storage is turned off in Settings.'}</p>}
        </article>
        {!!d.growth.length && (
          <article className="tile span-12">
            <div className="tile-head"><div><p className="eyebrow">Recent growth</p><h3>Repositories that grew this week</h3></div><Link className="btn btn-ghost" href="/filenex/storage/growth">Growth <Icon name="arrow" size={16} /></Link></div>
            {d.growth.map(g => <Bar key={g.projectId} label={<Link href={`/filenex/storage/developer/${encodeURIComponent(g.projectId)}`}>{g.name}</Link>} bytes={g.growth7dBytes ?? 0} max={d.growth[0].growth7dBytes ?? 1} right={signed(g.growth7dBytes ?? 0)} tone="moderate" />)}
          </article>
        )}
      </div>
    </>
  );
}

function RepoDetailPage({ id, rev, setToast }: { id: string; rev: number; setToast: (t: Toasty) => void }) {
  const now = useNow(60_000);
  const [d, setD] = useState<RepoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<RepoDetail>(`/developer/${encodeURIComponent(id)}`).then(x => { setD(x); setError(null); }).catch(e => setError((e as Error).message)); }, [id, rev]);
  if (error) return <EmptyState title="Repository not available">{error} <Link href="/filenex/storage/developer">Developer Storage</Link></EmptyState>;
  if (!d) return <EmptyState title="Loading…" />;
  const r = d.repo;
  if (!r.available) return (
    <>
      <div className="project-head"><div><p className="eyebrow">Repository</p><h2 className="context-title">{r.name}</h2><p className="path">{r.path}</p></div></div>
      <div className="table"><EmptyState title="Storage analysis unavailable">{UNAVAILABLE[r.unavailableReason ?? 'not-approved']} {r.unavailableReason === 'not-approved' && 'DevNEX knows where the repository is; FileNEX still needs your permission to analyze it.'}</EmptyState>
        {(r.unavailableReason === 'not-approved' || r.unavailableReason === 'partial') && <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 24 }}><Link className="btn btn-ink" href={`/filenex/settings?add=1&path=${encodeURIComponent(r.path)}`}><Icon name="plus" size={14} />Allow folder</Link></div>}
      </div>
    </>
  );
  const parts = (['source', 'dependencies', 'build', 'cache', 'logs', 'git', 'other'] as const).map(k => ({ k, bytes: { source: r.sourceBytes, dependencies: r.dependencyBytes, build: r.buildBytes, cache: r.cacheBytes, logs: r.logBytes, git: r.gitBytes, other: r.otherBytes }[k] }));
  const max = Math.max(1, ...parts.map(p => p.bytes));
  const reviewable = r.breakdown.filter(e => e.risk !== 'PROTECTED');
  const reveal = async () => { try { await post(`${API}/reveal`, { path: r.path }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } };
  return (
    <>
      <div className="project-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {r.isActiveProject ? <Pill tone="ok">Active project</Pill> : <Pill tone="muted">Not active</Pill>}
            {r.recentlyUsed && <Pill tone="system">Recently used today</Pill>}
            {r.nested && <Pill tone="system">Inside another project</Pill>}
          </div>
          <h2 className="context-title" style={{ marginTop: 10 }}>{r.name}</h2>
          <p className="big-num" style={{ marginTop: 8 }}>{fb(r.totalBytes).split(' ')[0]}<span> {fb(r.totalBytes).split(' ')[1]}</span></p>
          <p className="path" title={r.path}>{r.path}</p>
        </div>
        <div className="actions">
          <button className="btn btn-line" onClick={reveal}><Icon name="folder" size={14} />Reveal folder</button>
          <Link className="btn btn-line" href={`/devnex/projects/${encodeURIComponent(r.projectId)}`}><Icon name="code" size={14} />Open DevNEX</Link>
          {!!reviewable.length && <Link className="btn btn-ink" href={`/filenex/storage/cleanup?project=${encodeURIComponent(r.projectId)}`}>Review cleanup</Link>}
        </div>
      </div>
      {r.isActiveProject && <div className="notice"><Icon name="lock" size={16} /><div><b>Active project</b>FileNEX doesn’t recommend broad repository cleanup here. Only regeneratable items are shown — dependencies of active work are not counted as recoverable, and build output of running services is marked “review carefully”.</div></div>}
      {d.old && <div className="notice"><Icon name="history" size={16} /><div><b>Inactive for {r.inactiveDays} days{d.gitClean ? ' · Git clean' : ''} · {r.runningServiceCount} services running</b>Its regeneratable folders are worth reviewing: {reviewable.filter(e => e.recoverable).slice(0, 3).map(e => `${e.name} (${fb(e.bytes)})`).join(', ') || 'none'}. The repository itself may still be valuable — FileNEX never suggests removing it.</div></div>}
      <div className="bento">
        <article className="tile span-4">
          <p className="eyebrow">Context</p>
          <dl className="kv">
            <dt>Status</dt><dd>{r.runningServiceCount ? `Active · ${r.runningServiceCount} service${r.runningServiceCount > 1 ? 's' : ''} running` : r.isActiveProject ? 'Active project' : 'Not active'}</dd>
            <dt>Last activity</dt><dd>{daysAgo(r.lastActiveAt, now)}{r.lastActiveSource ? ` · ${r.lastActiveSource === 'worknex' ? 'WorkNEX' : 'file changes'}` : ''}</dd>
            {d.git?.isRepo && <><dt>Git branch</dt><dd>{d.git.branch ?? '—'}</dd><dt>Git</dt><dd>{d.gitClean ? 'Clean' : `${d.git.changed} changed · ${d.git.untracked} untracked`}</dd></>}
            <dt>Services</dt><dd>{r.runningServiceCount} running</dd>
            <dt>Analyzed</dt><dd>{since(r.analyzedAt, now)}</dd>
          </dl>
        </article>
        <article className="tile span-8">
          <div className="tile-head"><div><p className="eyebrow">What uses the space</p><h3>{fb(r.totalBytes)} on disk</h3></div></div>
          {parts.filter(p => p.bytes > 0).map(p => <Bar key={p.k} label={CATEGORY_TEXT[p.k].label} sub={CATEGORY_TEXT[p.k].text} bytes={p.bytes} max={max} tone={p.k === 'source' || p.k === 'git' || p.k === 'other' ? 'muted' : undefined} />)}
          {!!r.dockerRelatedBytes && <Bar label="Docker-related" sub="Images and volumes of this project’s Compose stack (estimate) — stored in Docker’s disk image, not in this folder" bytes={r.dockerRelatedBytes} max={max} right={fb(r.dockerRelatedBytes)} />}
        </article>
        <article className="tile span-4">
          <p className="eyebrow">Potential recovery</p>
          <p className="big-num">{fb(r.recoverableEstimateBytes).split(' ')[0]}<span> {fb(r.recoverableEstimateBytes).split(' ')[1]}</span></p>
          <p className="fine">Conservative: regeneratable caches and build output{r.isActiveProject ? '' : ', dependencies of this inactive project'}, and old logs. Never source, Git or .env.</p>
        </article>
        <article className="tile span-8">
          <p className="eyebrow">Growth · last 7 days</p>
          {d.growth ? <>
            <dl className="facts"><div><dt>7 days ago</dt><dd className="mid-num">{fb(d.growth.fromBytes)}</dd></div><div><dt>Now</dt><dd className="mid-num">{fb(d.growth.toBytes)}</dd></div><div><dt>Change</dt><dd className="mid-num">{signed(d.growth.deltaBytes)}</dd></div></dl>
            <ul className="feed">{d.growth.parts.slice(0, 5).map(p => <li key={p.key}><span>{p.label}</span><b className="num">{signed(p.deltaBytes)}</b></li>)}</ul>
          </> : <p className="fine">Not enough history yet — growth appears after analyses on different days.</p>}
        </article>
      </div>
      {!!r.worktrees.length && <>
        <h3 className="section-title" style={{ marginTop: 24 }}>Git worktrees · {r.worktrees.length} · {fb(r.worktrees.reduce((n, w) => n + w.totalBytes, 0))}</h3>
        <p className="fine section-note">Separate checkouts of this repository, each with its own dependencies. Their bytes are already included in the categories above.</p>
        <div className="table st-scroll" role="table">
          <div className="tr th cols-worktrees" role="row"><span>Branch</span><span className="r">Size</span><span className="r">Dependencies</span><span>Last commit</span><span>Status</span></div>
          {r.worktrees.map(w => (
            <div className="tr cols-worktrees row-wrap" role="row" key={w.path}>
              <span className="cell-app"><span style={{ minWidth: 0 }}><b title={w.name}>{w.name}</b><small className="mono st-path" title={w.path}>{midPath(w.path)}</small></span></span>
              <span className="num r"><b>{fb(w.totalBytes)}</b></span>
              <span className="num r">{fb(w.dependencyBytes)}</span>
              <span className="fine" style={{ margin: 0, whiteSpace: 'normal' }}>{w.lastCommitAt ? `${daysAgo(w.lastCommitAt, now)} · ${w.lastCommitSubject ?? ''}` : '—'}</span>
              <span>{w.uncommitted ? <Pill tone="protected" lock>{w.status}</Pill> : w.inUse ? <Pill tone="warn">{w.status}</Pill> : <Pill tone="muted">{w.status}</Pill>}</span>
            </div>
          ))}
        </div>
      </>}
      <h3 className="section-title" style={{ marginTop: 24 }}>Breakdown</h3>
      <EntryTable entries={r.breakdown} now={now} />
    </>
  );
}

function EntryTable({ entries, now }: { entries: StorageEntry[]; now: number }) {
  return (
    <div className="table st-scroll" role="table">
      <div className="tr th cols-entries" role="row"><span>Folder</span><span className="r">Size</span><span>Classification</span><span>Regeneratable</span><span>Why</span></div>
      {entries.map(e => (
        <div className="tr cols-entries row-wrap" role="row" key={e.id}>
          <span className="cell-app"><span style={{ minWidth: 0 }}><b title={e.label ?? e.name}>{e.label ?? e.name}</b>{e.detail && e.detail !== e.projectName && <small className="st-detail">{e.detail}</small>}<small className="mono st-path" title={e.path}>{midPath(e.path)}{e.lastUsedAt && e.container ? ` · changed ${daysAgo(e.lastUsedAt, now).toLowerCase()}` : ''}</small></span></span>
          <span className="num r"><b>{fb(e.bytes)}</b></span>
          <span><RiskPill risk={e.risk} /></span>
          <span className="fine" style={{ margin: 0 }}>{e.regeneratable ? 'Regeneratable' : '—'}</span>
          <span className="fine" style={{ margin: 0, whiteSpace: 'normal' }}>{e.reason}{e.git ? ` (Git: ${e.git})` : ''}</span>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Duplicates (storage view) ───────────────────────── */
function StorageDuplicates() {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  useEffect(() => { fetch('/api/filenex/duplicates').then(r => r.json()).then(setGroups).catch(() => setGroups([])); }, []);
  if (!groups) return <EmptyState title="Loading…" />;
  const exact = groups.filter(g => g.kind === 'exact').map(g => ({ g, wasted: g.files[0].sizeBytes * (g.files.length - 1) })).sort((a, b) => b.wasted - a.wasted);
  const total = exact.reduce((n, x) => n + x.wasted, 0);
  const max = Math.max(1, ...exact.map(x => x.wasted));
  return (
    <>
      <p className="fine section-note">Exact duplicates in your indexed files (same size and content hash). Extra copies use <b>{fb(total)}</b>. {groups.length - exact.length} possible duplicate groups are in <Link href="/filenex/duplicates">Duplicates</Link>. FileNEX never deletes files.</p>
      {exact.length ? <div className="tile">{exact.slice(0, 60).map(({ g, wasted }) => (
        <Bar key={g.key} label={<Link href={`/filenex/files/${g.files[0].id}`}>{g.files[0].name}</Link>} sub={`${g.files.length} copies · ${fb(g.files[0].sizeBytes)} each · ${g.files.map(f => f.parentPath.split(/[\\/]/).pop()).join(', ')}`} bytes={wasted} max={max} right={`${fb(wasted)} extra`} />
      ))}</div> : <div className="table"><EmptyState title="No exact duplicates">Exact duplicates are confirmed by hashing files of identical size in your indexed folders.</EmptyState></div>}
    </>
  );
}

/* ───────────────────────── Growth ───────────────────────── */
type GrowthRes = { days: number; volume: DiskVolume | null; growth: Growth; forecast: StorageForecast; daily: { day: string; usedBytes: number }[]; repos: { projectId: string; name: string; deltaBytes: number; fromBytes: number; toBytes: number; parts: { key: string; label: string; deltaBytes: number }[] }[]; historyEnabled: boolean; snapshots: number };
function GrowthPage({ rev }: { rev: number }) {
  const [days, setDays] = useState<'7' | '30'>('7');
  const [g, setG] = useState<GrowthRes | null>(null);
  useEffect(() => { get<GrowthRes>(`/growth?days=${days}`).then(setG).catch(() => {}); }, [days, rev]);
  if (!g) return <EmptyState title="Loading…" />;
  const gr = g.growth;
  const top = gr ? gr.breakdown.filter(b => b.kind !== 'repo' && b.kind !== 'folder') : [];
  const folders = gr ? gr.breakdown.filter(b => b.kind === 'folder' || b.kind === 'repo') : [];
  const maxB = Math.max(1, ...[...top, ...folders].map(b => Math.abs(b.deltaBytes)), Math.abs(gr?.otherDeltaBytes ?? 0));
  const minUsed = Math.min(...g.daily.map(d => d.usedBytes)), maxUsed = Math.max(...g.daily.map(d => d.usedBytes));
  return (
    <>
      <div className="toolbar"><Segmented options={['7', '30'] as const} value={days} onChange={setDays} label={v => `Last ${v} days`} /></div>
      {!g.historyEnabled && <div className="notice"><Icon name="pause" size={16} /><div><b>Storage history is off.</b>Turn it on in <Link className="chip-action" href="/filenex/settings#storage">Settings</Link> to see growth.</div></div>}
      <div className="bento">
        <article className="tile span-7">
          <p className="eyebrow">What grew? · last {days} days</p>
          {gr ? <>
            <p className="big-num">{signed(gr.usedDeltaBytes)}</p>
            <p className="fine">Change in used space since {new Date(gr.from).toLocaleDateString()}.</p>
            {top.map(b => <Bar key={b.key} label={b.label} sub={b.kind === 'docker' ? 'Docker' : b.kind === 'shared' ? 'Shared cache' : 'Approved folder'} bytes={Math.abs(b.deltaBytes)} max={maxB} right={signed(b.deltaBytes)} tone={b.deltaBytes > 0 ? 'moderate' : 'healthy'} />)}
            {folders.filter(b => b.deltaBytes > 100 * MB).slice(0, 6).map(b => <div className="st-sub" key={b.key}><span>{b.kind === 'repo' ? 'Repository · ' : ''}{b.label}</span><span className="num">{signed(b.deltaBytes)}</span></div>)}
            <Bar label="Other" sub="Outside analyzed folders (apps, system, caches) — not attributed" bytes={Math.abs(gr.otherDeltaBytes)} max={maxB} right={signed(gr.otherDeltaBytes)} tone="muted" />
            {!gr.attributed && <p className="fine">A breakdown appears once two analyses are at least a day apart.</p>}
          </> : <EmptyState title="Not enough history yet">FileNEX keeps a small local snapshot about once an hour. Growth appears after a day of history.</EmptyState>}
        </article>
        <article className="tile span-5">
          <p className="eyebrow">Forecast</p>
          {g.forecast.enough ? <>
            <dl className="facts">
              <div><dt>Free space</dt><dd className="mid-num">{fb(g.volume?.freeBytes)}</dd></div>
              <div><dt>Recent growth</dt><dd className="mid-num">{signed(g.forecast.ratePerWeekBytes ?? 0)}/week</dd></div>
            </dl>
            <p className="insight-headline" style={{ fontSize: 17 }}>{g.forecast.message}</p>
            <p className="fine">A straight-line trend over the last {g.forecast.basisDays} days. A rough estimate, not a prediction.</p>
          </> : <p className="fine">Not enough history to estimate.</p>}
        </article>
        {g.daily.length > 1 && (
          <article className="tile span-12">
            <p className="eyebrow">Used space by day</p>
            <div className="st-days">{g.daily.map(d => <div key={d.day} title={`${d.day}: ${fb(d.usedBytes)}`}><i style={{ height: `${maxUsed > minUsed ? 15 + 85 * ((d.usedBytes - minUsed) / (maxUsed - minUsed)) : 50}%` }} /><small>{d.day.slice(5)}</small></div>)}</div>
            <p className="fine">{fb(minUsed)} – {fb(maxUsed)} used · {g.snapshots} snapshots kept locally</p>
          </article>
        )}
        <article className="tile span-12">
          <p className="eyebrow">Repository growth</p>
          {g.repos.length ? (
            <div className="table st-scroll" role="table" style={{ border: 0 }}>
              <div className="tr th cols-growth" role="row"><span>Repository</span><span className="r">{days} days ago</span><span className="r">Now</span><span className="r">Change</span><span>Largest contributors</span></div>
              {g.repos.map(r => (
                <div className="tr cols-growth row-wrap" role="row" key={r.projectId}>
                  <span><Link href={`/filenex/storage/developer/${encodeURIComponent(r.projectId)}`}><b>{r.name}</b></Link></span>
                  <span className="num r">{fb(r.fromBytes)}</span><span className="num r">{fb(r.toBytes)}</span><span className="num r"><b>{signed(r.deltaBytes)}</b></span>
                  <span className="fine" style={{ margin: 0 }}>{r.parts.filter(p => p.deltaBytes > 0).slice(0, 3).map(p => `${p.label} ${signed(p.deltaBytes)}`).join(' · ') || '—'}</span>
                </div>
              ))}
            </div>
          ) : <p className="fine">Repository growth appears after two analyses on different days.</p>}
        </article>
      </div>
    </>
  );
}

/* ───────────────────────── Cleanup review ───────────────────────── */
const GROUP_LABEL: Record<CleanupCandidate['group'], string> = {
  worktrees: 'Git worktrees', build: 'Developer build artifacts', cache: 'Developer caches', dependencies: 'Regeneratable dependencies', logs: 'Old logs', downloads: 'Old downloads',
  'large-old': 'Large old files', duplicates: 'Duplicates', docker: 'Docker unused data', 'shared-cache': 'Shared package caches',
};
type Preview = { selected: number; totalBytes: number; projectsAffected: number; projects: { id: string; name: string }[]; items: { id: string; path: string; name: string; label: string; detail: string | null; bytes: number; risk: CleanupRisk; regeneratable: boolean; regenerate: string | null; reason: string; projectName: string | null; group: string }[]; overlapping: number; unknown: string[]; note: string };

function CleanupReview({ rev, setToast }: { rev: number; setToast: (t: Toasty) => void }) {
  const now = useNow(60_000);
  const params = useSearchParams();
  const project = params.get('project');
  const [cands, setCands] = useState<CleanupCandidate[] | null>(null);
  const [risk, setRisk] = useState<'All' | 'Safe to review' | 'Review carefully'>('All');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => { get<CleanupCandidate[]>('/cleanup-candidates').then(setCands).catch(() => setCands([])); }, [rev]);
  const list = useMemo(() => (cands ?? []).filter(c => (!project || c.projectId === project) && (risk === 'All' || RISK[c.risk].label === risk)), [cands, risk, project]);
  const groups = useMemo(() => {
    const m = new Map<string, CleanupCandidate[]>();
    for (const c of list) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()].sort((a, b) => b[1].reduce((n, c) => n + c.bytes, 0) - a[1].reduce((n, c) => n + c.bytes, 0));
  }, [list]);
  if (!cands) return <EmptyState title="Finding review opportunities…" />;
  const selectedBytes = (cands ?? []).filter(c => picked.has(c.id)).reduce((n, c) => n + c.bytes, 0);
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openPreview = async () => { try { setPreview(await post<Preview>(`${API}/cleanup-preview`, { ids: [...picked] })); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } };
  const reveal = async (path: string) => { try { await post(`${API}/reveal`, { path }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } };
  const projectName = project ? cands.find(c => c.projectId === project)?.projectName : null;
  /** Report for another assistant: the selection, or what the current filter shows. */
  const reportHref = (selectedOnly: boolean) => {
    const p = new URLSearchParams();
    if (selectedOnly) p.set('ids', [...picked].join(','));
    else { if (risk !== 'All') p.set('risk', risk === 'Safe to review' ? 'SAFE_TO_REVIEW' : 'REVIEW_CAREFULLY'); if (project) p.set('project', project); }
    return `${API}/cleanup-report.md?${p}`;
  };
  return (
    <>
      <div className="toolbar">
        <FilterChips options={['All', 'Safe to review', 'Review carefully'] as const} value={risk} onChange={setRisk} counts={{ All: cands.filter(c => !project || c.projectId === project).length, 'Safe to review': cands.filter(c => c.risk === 'SAFE_TO_REVIEW' && (!project || c.projectId === project)).length, 'Review carefully': cands.filter(c => c.risk === 'REVIEW_CAREFULLY' && (!project || c.projectId === project)).length }} />
        {project && <span className="chip on">{projectName ?? 'Project'} <Link href="/filenex/storage/cleanup" aria-label="Show all projects" style={{ color: 'inherit', marginLeft: 6 }}><Icon name="close" size={12} /></Link></span>}
        {!!list.length && <a className="btn btn-line btn-sm" style={{ marginLeft: 'auto' }} href={reportHref(false)} download="filenex-cleanup-report.md" title="Markdown report with exact paths and safety rules, to continue the cleanup with Claude"><Icon name="external" size={12} />Export for Claude</a>}
      </div>
      <p className="fine section-note">Analyze first. Delete deliberately. These are review opportunities — FileNEX never deletes anything. Select items to preview exactly what they cover, then remove what you no longer need yourself. Source code, Git history, documents, photos, videos, .env files and databases are protected and never listed.</p>
      {groups.length ? groups.map(([group, items]) => (
        <Fragment key={group}>
          <div className="tile-head" style={{ marginTop: 18, marginBottom: 8 }}><div><p className="eyebrow" style={{ margin: 0 }}>{GROUP_LABEL[group as CleanupCandidate['group']]} · {items.length}</p>{group === 'worktrees' && <p className="fine" style={{ margin: '2px 0 0' }}>Separate checkouts (e.g. Claude Code agents in .claude/worktrees), each with its own node_modules. Remove with <code>git worktree remove</code> — the branch and its commits stay. Worktrees with uncommitted changes are never listed here.</p>}</div><b className="num" style={{ whiteSpace: 'nowrap' }}>{fb(items.reduce((n, c) => n + c.bytes, 0))}</b></div>
          <div className="table st-scroll" role="table">
            <div className="tr th cols-clean" role="row"><span /><span>Item</span><span className="r">Size</span><span>Risk</span><span>Regeneratable</span><span>Last used</span><span>Project</span><span /></div>
            {items.map(c => (
              <div className={`tr cols-clean row-wrap ${picked.has(c.id) ? 'st-picked' : ''}`} role="row" key={c.id}>
                <span><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></span>
                <span className="cell-app" style={{ minWidth: 0 }}><span style={{ minWidth: 0 }}><b title={c.label ?? c.name}>{c.label ?? c.name}</b>{c.detail && <small className="st-detail" title={c.detail}>{c.detail}</small>}<small className="mono st-path" title={c.path}>{c.path.startsWith('docker:') ? 'Docker' : midPath(c.path, 48)}</small><small className="st-reason">{c.reason}{c.recoverable ? '' : ' · not counted as recoverable'}</small></span></span>
                <span className="num r"><b>{fb(c.bytes)}</b></span>
                <span><RiskPill risk={c.risk} /></span>
                <span className="fine" style={{ margin: 0 }}>{c.regeneratable ? 'Regeneratable' : 'No'}</span>
                <span className="fine" style={{ margin: 0 }}>{c.lastUsedAt ? daysAgo(c.lastUsedAt, now) : '—'}</span>
                <span className="fine" style={{ margin: 0 }}>{c.projectName ?? '—'}</span>
                <span className="cell-actions">{c.regenerate && c.group === 'worktrees' && <button className="btn btn-ghost btn-sm" title={c.regenerate} onClick={() => { navigator.clipboard?.writeText(c.regenerate!); setToast({ tone: 'ok', text: 'Command copied — run it in a terminal when you are sure.' }); }}>Copy command</button>}{!c.path.startsWith('docker:') && <button className="btn btn-ghost btn-sm" onClick={() => reveal(c.path)}>Reveal</button>}</span>
              </div>
            ))}
          </div>
        </Fragment>
      )) : <div className="table"><EmptyState title="Nothing to review">{cands.length ? 'No items match this filter.' : 'Candidates appear after FileNEX analyzes your approved folders: build output, caches, old logs, old downloads, duplicates, Docker unused data.'}</EmptyState></div>}

      {picked.size > 0 && (
        <div className="st-selbar" role="region" aria-label="Selection">
          <span><b>{picked.size}</b> selected · <b>{fb(selectedBytes)}</b></span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setPicked(new Set())}>Clear</button>
            <a className="btn btn-line" href={reportHref(true)} download="filenex-cleanup-report.md">Export selected for Claude</a>
            <button className="btn btn-ink" onClick={openPreview}>Preview cleanup</button>
          </span>
        </div>
      )}

      {preview && (
        <Modal onClose={() => setPreview(null)}>
          <div className="modal-wide">
            <p className="eyebrow">Cleanup preview</p>
            <h2 className="h2">Review exactly what this covers</h2>
            <dl className="facts" style={{ margin: '14px 0' }}>
              <div><dt>Selected</dt><dd className="mid-num">{preview.selected} item{preview.selected === 1 ? '' : 's'}</dd></div>
              <div><dt>Total size</dt><dd className="mid-num">{fb(preview.totalBytes)}</dd></div>
              <div><dt>Projects affected</dt><dd className="mid-num">{preview.projectsAffected}</dd></div>
            </dl>
            {preview.overlapping > 0 && <p className="fine">{preview.overlapping} selected item{preview.overlapping > 1 ? 's are' : ' is'} inside another selected folder — counted once.</p>}
            <ul className="st-paths">{preview.items.map(i => <li key={i.id}><span><b>{i.label}</b>{i.detail && <small style={{ display: 'block' }}>{i.detail}</small>}<span className="mono" title={i.path}>{i.path.startsWith('docker:') ? 'Docker' : i.path}</span></span><span className="num">{fb(i.bytes)}</span>{i.regenerate && <small>{i.group === 'worktrees' ? 'Remove with' : 'Re-create with'}: <code>{i.regenerate}</code></small>}</li>)}</ul>
            <div className="notice" style={{ marginTop: 12 }}><Icon name="lock" size={16} /><div><b>Nothing has been deleted.</b>{preview.note}</div></div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setPreview(null)}>Close</button>
              <button className="btn btn-line" onClick={() => { navigator.clipboard?.writeText(preview.items.filter(i => !i.path.startsWith('docker:')).map(i => i.path).join('\n')); setToast({ tone: 'ok', text: 'Paths copied.' }); }}><Icon name="copy" size={13} />Copy paths</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ───────────────────────── Settings (embedded in FileNEX › Settings) ───────────────────────── */
function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}><i /></button>;
}

export function StorageSettingsSection({ setToast }: { setToast: (t: Toasty) => void }) {
  const [s, setS] = useState<StorageSettings | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [withAnalyses, setWithAnalyses] = useState(false);
  const load = useCallback(() => get<StorageSettings>('/settings').then(setS).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const save = async (patch: Partial<StorageSettings>, text?: string) => {
    try { setS(await call<StorageSettings>('PUT', '/settings', patch)); if (text) setToast({ tone: 'ok', text }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); load(); }
  };
  if (!s) return null;
  const T = s.thresholds;
  return (
    <>
      <p className="eyebrow" style={{ marginTop: 28 }} id="storage">Storage analysis</p>
      <div className="settings">
        <Setting title="Enable storage analysis" text="Measures sizes inside your approved folders only (no folder permission, no scanning). Disk capacity is always shown. Nothing is ever deleted automatically.">
          <Switch on={s.enabled} label="Storage analysis" onChange={v => save({ enabled: v }, v ? 'Storage analysis on.' : 'Storage analysis off.')} />
        </Setting>
        <Setting title="Automatic deletion" text="Not available — by design. FileNEX analyzes and previews; you decide and act.">
          <span className="chip chip-local"><Icon name="lock" size={13} />Off</span>
        </Setting>
        <Setting title="Scan schedule" text="How often approved folders are re-measured. Unchanged developer folders are reused, so updates are quick.">
          <select className="select" value={s.scanEveryHours} onChange={e => save({ scanEveryHours: Number(e.target.value) })} aria-label="Scan schedule">
            <option value={6}>Every 6 hours</option><option value={24}>Daily</option><option value={168}>Weekly</option><option value={0}>Only when I ask</option>
          </select>
        </Setting>
        <Setting title="Large file threshold" text="Default size for the Large Files view.">
          <select className="select" value={s.largeFileThresholdMb} onChange={e => save({ largeFileThresholdMb: Number(e.target.value) })} aria-label="Large file threshold">
            <option value={100}>100 MB</option><option value={500}>500 MB</option><option value={1024}>1 GB</option><option value={5120}>5 GB</option>
          </select>
        </Setting>
        <Setting title="Storage history" text="A few numbers about once an hour, kept on this computer — used for growth and the forecast.">
          <Switch on={s.historyEnabled} label="Storage history" onChange={v => save({ historyEnabled: v })} />
        </Setting>
        <Setting title="History retention" text="Older snapshots are removed automatically.">
          <select className="select" value={s.historyRetentionDays} onChange={e => save({ historyRetentionDays: Number(e.target.value) })} aria-label="History retention">
            <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option>
          </select>
        </Setting>
        <Setting title="Status levels" text={`Free space below these levels changes the status (whichever is lower: GB, or % of the disk). Attention ${T.attention.gb} GB / ${T.attention.percent}% · Low ${T.low.gb} GB / ${T.low.percent}% · Critical ${T.critical.gb} GB / ${T.critical.percent}%.`}>
          <select className="select" value={`${T.attention.gb}/${T.low.gb}/${T.critical.gb}`} aria-label="Status levels" onChange={e => { const [a, l, c] = e.target.value.split('/').map(Number); save({ thresholds: { attention: { ...T.attention, gb: a }, low: { ...T.low, gb: l }, critical: { ...T.critical, gb: c } } }); }}>
            <option value="25/15/5">Relaxed · 25 / 15 / 5 GB</option><option value="50/25/10">Default · 50 / 25 / 10 GB</option><option value="100/50/20">Cautious · 100 / 50 / 20 GB</option>
            {![`25/15/5`, '50/25/10', '100/50/20'].includes(`${T.attention.gb}/${T.low.gb}/${T.critical.gb}`) && <option value={`${T.attention.gb}/${T.low.gb}/${T.critical.gb}`}>Custom</option>}
          </select>
        </Setting>
        <Setting title="Clear storage history" text="Deletes FileNEX’s storage snapshots (and optionally its cached analyses). Your files are never touched.">
          <button className="btn btn-line" onClick={() => setConfirm(true)}>Clear history…</button>
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Developer storage</p>
      <div className="settings">
        <Setting title="Analyze DevNEX projects" text="Show the storage of DevNEX repositories that are inside your approved folders. A DevNEX project outside them is never scanned.">
          <Switch on={s.analyzeDevProjects} label="Analyze DevNEX projects" onChange={v => save({ analyzeDevProjects: v })} />
        </Setting>
        <Setting title="Dependency detection" text="Recognise node_modules, virtualenvs and vendor folders.">
          <Switch on={s.detectDependencies} label="Dependency detection" onChange={v => save({ detectDependencies: v })} />
        </Setting>
        <Setting title="Build artifact detection" text="Recognise .next, dist, build, out, target, caches and coverage (generic names only inside projects).">
          <Switch on={s.detectBuildArtifacts} label="Build artifact detection" onChange={v => save({ detectBuildArtifacts: v })} />
        </Setting>
        <Setting title="Docker storage" text="Read sizes from docker system df (images, volumes, build cache). Never prunes.">
          <Switch on={s.dockerStorage} label="Docker storage" onChange={v => save({ dockerStorage: v })} />
        </Setting>
        <Setting title="Shared developer caches" text="Measure the total size of npm, pnpm and Yarn caches. They are outside your folders, so this is off unless you allow it — size only, no file names.">
          <Switch on={s.sharedCaches} label="Shared developer caches" onChange={v => save({ sharedCaches: v }, v ? 'Measuring shared caches…' : 'Shared caches are no longer measured.')} />
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Performance</p>
      <div className="settings">
        <Setting title="Pause during high CPU" text="Background storage analysis waits while CPU is above 85% (shared system monitor, as in MemNEX).">
          <Switch on={s.pauseOnHighCpu} label="Pause during high CPU" onChange={v => save({ pauseOnHighCpu: v })} />
        </Setting>
        <Setting title="Pause during memory pressure" text="Background storage analysis waits while memory pressure is high.">
          <Switch on={s.pauseOnMemoryPressure} label="Pause during memory pressure" onChange={v => save({ pauseOnMemoryPressure: v })} />
        </Setting>
      </div>

      {confirm && (
        <Modal onClose={() => setConfirm(false)}>
          <p className="eyebrow">Clear storage history</p><h2 className="h2">Delete FileNEX’s storage history?</h2>
          <p>This deletes <b>only FileNEX’s snapshots</b> used for growth and forecasts. <b>No file is deleted, moved or changed.</b></p>
          <label className="resume-item" style={{ marginTop: 12 }}><input type="checkbox" checked={withAnalyses} onChange={e => setWithAnalyses(e.target.checked)} /><span><b>Also delete the cached analyses</b><small>Your approved folders are measured again on the next analysis.</small></span></label>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={async () => { try { await call('DELETE', `/history?confirmed=true&includeAnalyses=${withAnalyses}`); setToast({ tone: 'ok', text: 'Storage history cleared. Your files are untouched.' }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } setConfirm(false); }}>Clear history</button></div>
        </Modal>
      )}
    </>
  );
}
