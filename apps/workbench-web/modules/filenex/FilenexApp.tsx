'use client';
/* FileNEX — Local File Intelligence. Find the work, not the filename. */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { DuplicateGroup, FileRecord, FileType, FilenexSettings, LocationStatus, RelatedFile, SearchHit, VersionGroup } from '@nex/filenex';
import { EmptyState, FilterChips, Icon, Modal, Pill, Segmented, Setting, Stat, Toast, Wordmark as UiWordmark, createPost, fmtBytes, since, useNow, useToast, type IconName } from '@nex/ui';
import { useWorkbench } from '../../shell/context';
import { PageHeader } from '../../shell/PageHeader';
import { StoragePage, StorageSettingsSection, storageTabLabel } from './StorageApp';

/* ───────────────────────── Types & helpers ───────────────────────── */
type Page = 'Overview' | 'Search' | 'Storage' | 'Collections' | 'Versions' | 'Duplicates' | 'Settings';
type Status = { state: 'idle' | 'scanning' | 'updating' | 'paused' | 'error'; paused: boolean; locations: LocationStatus[]; indexedFiles: number; indexBytes: number; configured: boolean; lastScanAt: string | null };
type WorkGroup = { id: string; title: string; type: string; lastActiveAt: string; isActive: boolean; files: FileRecord[] };
type Detail = { file: FileRecord; exists: boolean; contexts: { id: string; title: string; lastActiveAt: string }[]; project: { id: string; name: string; path: string } | null; versions: VersionGroup | null; duplicate: DuplicateGroup | null; collections: { id: string; name: string }[]; related: RelatedFile[] };
type Collections = { work: { id: string; name: string; type: string; files: number; lastActiveAt: string }[]; projects: { id: string; name: string; path: string; files: number; recent: number; indexed: boolean }[]; user: { id: string; name: string; files: number; createdAt: string }[] };
type CollectionView = { id: string; kind: string; name: string; files: FileRecord[]; total: number; byType: Record<string, number>; note: string | null };
type Toasty = { tone: 'ok' | 'error'; text: string };

const API = '/api/filenex';
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

const PAGES: Page[] = ['Overview', 'Search', 'Storage', 'Collections', 'Versions', 'Duplicates', 'Settings'];
const slugOf = (p: Page) => (p === 'Overview' ? '' : p.toLowerCase());
const TYPE_LABEL: Record<FileType, string> = { presentation: 'Presentation', spreadsheet: 'Spreadsheet', document: 'Document', pdf: 'PDF', text: 'Text', data: 'Data', code: 'Code', image: 'Image', design: 'Design', archive: 'Archive', video: 'Video', audio: 'Audio', other: 'File' };
const TYPE_ICON: Record<FileType, IconName> = { presentation: 'overview', spreadsheet: 'processes', document: 'file', pdf: 'file', text: 'logs', data: 'env', code: 'code', image: 'layers', design: 'layers', archive: 'folder', video: 'play', audio: 'activity', other: 'file' };
const FILTER_TYPES = ['Any', 'presentation', 'spreadsheet', 'document', 'pdf', 'text', 'image', 'code'] as const;
const DATE_FILTERS = ['Any time', 'Today', 'Yesterday', 'Last 7 days', 'Last 30 days'] as const;
const nf = (n: number) => n.toLocaleString('en-US');
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shortPath = (p: string, home = '') => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const when = (iso: string, now: number) => { const d = new Date(iso); const days = Math.floor((now - d.getTime()) / 86_400_000); return days < 1 ? `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : days < 2 ? 'Yesterday' : days < 30 ? `${days} days ago` : d.toLocaleDateString(); };

/* ───────────────────────── App ───────────────────────── */
export function FilenexApp() {
  const router = useRouter();
  const pathname = usePathname() || '/filenex';
  const params = useSearchParams();
  const [section, sub, third] = pathname.split('/').slice(2);
  const fileId = section === 'files' ? sub : null;
  const page: Page | null = fileId ? null : PAGES.find(p => slugOf(p) === (section ?? '')) ?? 'Overview';
  const { every, isEnabled, refreshSummary } = useWorkbench();
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [toast, setToast] = useToast<Toasty>(t => (t.tone === 'error' ? 9000 : 5000));

  const refresh = useCallback(async () => {
    try { setStatus(await get<Status>('/status')); setOffline(false); setUpdatedAt(new Date().toISOString()); }
    catch { setOffline(true); } finally { setLoading(false); }
  }, []);
  const scanning = status?.state === 'scanning' || status?.state === 'updating';
  useEffect(() => { refresh(); const t = setInterval(refresh, every(scanning ? 2000 : 8000)); return () => clearInterval(t); }, [refresh, every, scanning]);

  if (!isEnabled('filenex')) return <div className="boot boot-inline"><Wordmark /><h1>FileNEX is turned off.</h1><p>Turn it back on in <Link href="/settings">Workbench settings</Link>.</p></div>;
  if (loading) return <div className="boot boot-inline"><Wordmark /><p>Opening your file index…</p></div>;
  if (!status) return (
    <div className="boot boot-inline"><Wordmark /><h1>FileNEX can’t reach its local service.</h1><p>Run <code>npm run dev</code> in the NEXWorkbench folder, then this page reconnects on its own.</p></div>
  );

  // Storage works without folders (disk capacity needs no permission); everything else needs an approved folder.
  const notConfigured = !status.configured && page !== 'Settings' && page !== 'Storage';
  const storageTab = page === 'Storage' ? (sub ?? '') : '';
  const title = fileId ? 'File' : page === 'Overview' ? 'Find your work' : page === 'Storage' ? (storageTab ? storageTabLabel(storageTab) : 'Storage') : page!;
  const crumbs = page === 'Storage'
    ? [{ label: 'FileNEX', href: '/filenex' }, { label: 'Storage', href: storageTab ? '/filenex/storage' : undefined }, ...(storageTab ? [{ label: storageTabLabel(storageTab), href: third ? `/filenex/storage/${storageTab}` : undefined }] : [])]
    : [{ label: 'FileNEX', href: '/filenex' }, { label: fileId ? 'File' : page!, href: undefined }];
  const changed = () => { refresh(); refreshSummary(); };

  return (
    <>
      <PageHeader crumbs={crumbs} title={title} updatedAt={updatedAt} offline={offline} onRefresh={refresh} />
      {status.paused && <div className="notice"><Icon name="pause" size={16} /><div><b>Indexing paused</b>Search works on the existing index; nothing is scanned or updated. <button className="chip-action" onClick={async () => { await post(`${API}/index/resume`, {}); changed(); }}>Resume indexing</button></div></div>}
      {notConfigured ? <Welcome /> : <>
        {page === 'Overview' && <Overview status={status} />}
        {page === 'Search' && <SearchPage initial={params.get('q') ?? ''} status={status} />}
        {page === 'Storage' && <StoragePage tab={storageTab} id={third ? decodeURIComponent(third) : null} setToast={setToast} />}
        {page === 'Collections' && (sub ? <CollectionPage id={decodeURIComponent(sub)} setToast={setToast} onChanged={changed} /> : <CollectionsPage setToast={setToast} />)}
        {page === 'Versions' && <VersionsPage />}
        {page === 'Duplicates' && <DuplicatesPage />}
        {fileId && <FileDetail id={fileId} setToast={setToast} />}
      </>}
      {page === 'Settings' && <SettingsPage status={status} setToast={setToast} onChanged={changed} openAdd={params.get('add') === '1'} addPath={params.get('path')} clearAddParam={() => router.replace('/filenex/settings')} />}
      {toast && <Toast tone={toast.tone} text={toast.text} />}
    </>
  );
}

function Wordmark() { return <UiWordmark top="FILE" bottom="NEX" sub={['File', 'Intelligence']} label="FileNEX" variant="ink" />; }

function Welcome() {
  return (
    <div className="bento">
      <article className="tile span-7 tile-active">
        <p className="eyebrow">Welcome to FileNEX</p>
        <h2 className="context-title">FileNEX is not indexing any folders.</h2>
        <p style={{ margin: 0, maxWidth: '52ch' }}>Choose only the locations you want FileNEX to use for file intelligence. <b>No folder permission, no indexing</b> — nothing outside the folders you add is ever recorded.</p>
        <dl className="facts"><div><dt>Indexed locations</dt><dd>0</dd></div><div><dt>Indexed files</dt><dd>0</dd></div></dl>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link className="btn btn-ink" href="/filenex/settings?add=1"><Icon name="plus" size={14} />Add a folder</Link><Link className="btn btn-line" href="/filenex/storage">See disk space</Link></div>
      </article>
      <article className="tile span-5">
        <p className="eyebrow"><Icon name="lock" size={13} /> How FileNEX works</p>
        <ul className="feed">
          {['Local only — the index never leaves this computer', 'Metadata only: names, folders, sizes, dates', 'File contents are not read (except to confirm exact duplicates)', 'Never deletes, moves or renames files', 'DevNEX projects and WorkNEX files are not indexed unless you add their folder'].map(x => <li key={x}><span><Icon name="check" size={13} /> {x}</span><span /></li>)}
        </ul>
      </article>
    </div>
  );
}

/* ───────────────────────── Shared pieces ───────────────────────── */
function SearchBox({ initial = '', autoFocus = false, onSearch }: { initial?: string; autoFocus?: boolean; onSearch?: (q: string) => void }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  useEffect(() => setQ(initial), [initial]);
  const go = () => (onSearch ? onSearch(q) : router.push(`/filenex/search?q=${encodeURIComponent(q)}`));
  return (
    <form className="fx-search" onSubmit={e => { e.preventDefault(); go(); }} role="search">
      <Icon name="search" size={18} />
      <input value={q} onChange={e => { setQ(e.target.value); onSearch?.(e.target.value); }} autoFocus={autoFocus} placeholder="Search files, projects, topics… e.g. “ISO29110 presentation”, “excel edited yesterday”" aria-label="Search files" />
    </form>
  );
}

function FileRow({ f, now, extra, right }: { f: FileRecord; now: number; extra?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="fx-row">
      <Link href={`/filenex/files/${f.id}`} className="fx-main">
        <span className="app-icon"><Icon name={TYPE_ICON[f.fileType]} size={16} /></span>
        <span style={{ minWidth: 0 }}>
          <b title={f.name}>{f.name}</b>
          <small className="path" title={f.parentPath}>{f.parentPath}</small>
          {extra}
        </span>
      </Link>
      <span className="fx-meta"><span>{TYPE_LABEL[f.fileType]}</span><span>{when(f.modifiedAt, now)}</span></span>
      {right}
    </div>
  );
}

/* ───────────────────────── Overview ───────────────────────── */
function Overview({ status }: { status: Status }) {
  const now = useNow();
  const [work, setWork] = useState<WorkGroup[] | null>(null);
  const [recent, setRecent] = useState<FileRecord[] | null>(null);
  const [dups, setDups] = useState<number | null>(null);
  useEffect(() => {
    get<WorkGroup[]>('/recent-work').then(setWork).catch(() => setWork([]));
    get<FileRecord[]>('/recent').then(setRecent).catch(() => setRecent([]));
    get<DuplicateGroup[]>('/duplicates').then(d => setDups(d.length)).catch(() => setDups(null));
  }, [status.indexedFiles]);
  const scanning = status.locations.filter(l => l.state === 'scanning');
  return (
    <>
      <SearchBox autoFocus />
      <div className="fx-statusline">
        <span><b>{status.locations.length}</b> indexed location{status.locations.length === 1 ? '' : 's'}</span>
        <span><b>{nf(status.indexedFiles)}</b> files</span>
        <span>{scanning.length ? <><span className="live"><i />Indexing {scanning.map(l => `${l.label} · ${nf(l.scanned)} files`).join(', ')}</span></> : status.paused ? 'Paused' : status.lastScanAt ? `Up to date · last scan ${since(status.lastScanAt, now)}` : 'Waiting for first scan'}</span>
        {!!dups && <Link href="/filenex/duplicates" className="fine" style={{ margin: 0, color: 'var(--muted)' }}>{dups} possible duplicate group{dups === 1 ? '' : 's'}</Link>}
      </div>
      <div className="bento">
        <article className="tile span-5">
          <div className="tile-head"><div><p className="eyebrow">Recent work</p><h3>From WorkNEX</h3></div><Link className="btn btn-ghost" href="/filenex/collections">Collections <Icon name="arrow" size={16} /></Link></div>
          {!work ? <p className="fine">Loading…</p> : work.length ? (
            <ul className="feed">{work.map(w => (
              <li key={w.id}><Link href={`/filenex/collections/context:${w.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><b>{w.title}</b>{w.isActive && <> <Pill tone="ok">Active</Pill></>}</Link><span className="fine" style={{ margin: 0 }}>{w.files.length} file{w.files.length === 1 ? '' : 's'}</span></li>
            ))}</ul>
          ) : <EmptyState title="No recent work with indexed files">Work contexts appear here when WorkNEX saw files that are inside your indexed folders.</EmptyState>}
        </article>
        <article className="tile span-7">
          <div className="tile-head"><div><p className="eyebrow">Recent files</p><h3>Recently modified</h3></div><Link className="btn btn-ghost" href="/filenex/search?q=recent">More <Icon name="arrow" size={16} /></Link></div>
          {!recent ? <p className="fine">Loading…</p> : recent.length ? <div className="fx-list">{recent.slice(0, 8).map(f => <FileRow key={f.id} f={f} now={now} />)}</div>
            : <EmptyState title={scanning.length ? 'Indexing…' : 'Nothing indexed yet'}>{scanning.length ? 'Files appear here as soon as the first scan finishes.' : 'Run a scan from Settings.'}</EmptyState>}
        </article>
      </div>
    </>
  );
}

/* ───────────────────────── Search ───────────────────────── */
function SearchPage({ initial, status }: { initial: string; status: Status }) {
  const now = useNow();
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [type, setType] = useState<(typeof FILTER_TYPES)[number]>('Any');
  const [date, setDate] = useState<(typeof DATE_FILTERS)[number]>('Any time');
  const [location, setLocation] = useState('');
  const [res, setRes] = useState<{ hits: SearchHit[]; total: number; parsed: { interpreted: string[]; terms: string[] } } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setQ(initial), [initial]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const p = new URLSearchParams({ q });
      if (type !== 'Any') p.set('type', type);
      const today = new Date(); const ago = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return localDay(d); };
      if (date === 'Today') p.set('from', localDay(today));
      if (date === 'Yesterday') { p.set('from', ago(1)); p.set('to', ago(1)); }
      if (date === 'Last 7 days') p.set('from', ago(6));
      if (date === 'Last 30 days') p.set('from', ago(29));
      if (location) p.set('location', location);
      get<typeof res>(`/search?${p}`).then(setRes).catch(() => setRes({ hits: [], total: 0, parsed: { interpreted: [], terms: [] } }));
      router.replace(`/filenex/search?q=${encodeURIComponent(q)}`, { scroll: false });
    }, 180);
    return () => clearTimeout(timer.current);
  }, [q, type, date, location, router]);
  return (
    <>
      <SearchBox initial={initial} autoFocus onSearch={setQ} />
      <div className="toolbar" style={{ marginTop: 12 }}>
        <FilterChips options={FILTER_TYPES} value={type} onChange={setType} />
        <select className="select" value={date} onChange={e => setDate(e.target.value as typeof date)} aria-label="Modified">{DATE_FILTERS.map(d => <option key={d}>{d}</option>)}</select>
        {status.locations.length > 1 && <select className="select" value={location} onChange={e => setLocation(e.target.value)} aria-label="Location"><option value="">All locations</option>{status.locations.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</select>}
      </div>
      {res?.parsed.interpreted.length ? <p className="fine" style={{ marginTop: 0 }}>Understood: {res.parsed.interpreted.join(' · ')}{res.parsed.terms.length ? ` · words: ${res.parsed.terms.join(', ')}` : ''}</p> : null}
      {!res ? <EmptyState title="Searching…" /> : !res.hits.length ? (
        <div className="table"><EmptyState title={q || type !== 'Any' || date !== 'Any time' ? 'No files match' : 'Type to search'}>{q ? 'Try fewer words, a project or WorkNEX context name, or a type like “excel” or “presentation”.' : 'Search by name, part of a name, project, work context, type or date.'}</EmptyState></div>
      ) : (
        <div className="fx-list table">
          <div className="tl-session">{res.total > res.hits.length ? `Top ${res.hits.length} of ${nf(res.total)}` : `${res.total} result${res.total === 1 ? '' : 's'}`}</div>
          {res.hits.map(h => (
            <Fragment key={h.file.id}>
              <FileRow f={h.file} now={now}
                extra={<small className="fx-tags">
                  {h.latestHint === 'latest' && <span className="pill pill-ok">Likely latest</span>}
                  {h.latestHint === 'older' && <span className="pill pill-muted">Older version</span>}
                  {h.project && <span className="pill pill-system"><Icon name="code" size={11} />{h.project.name}</span>}
                  {h.contexts.slice(0, 2).map(c => <span key={c.id} className="pill pill-system"><Icon name="history" size={11} />{c.title}</span>)}
                </small>}
                right={<button className="btn btn-ghost btn-sm" onClick={() => setOpen(open === h.file.id ? null : h.file.id)} aria-expanded={open === h.file.id}>Why?</button>} />
              {open === h.file.id && <div className="fx-why"><b>Why this result?</b><ul>{h.reasons.map(r => <li key={r}>{r}</li>)}</ul></div>}
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

/* ───────────────────────── File detail ───────────────────────── */
function FileDetail({ id, setToast }: { id: string; setToast: (t: Toasty) => void }) {
  const now = useNow();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState<Collections['user']>([]);
  useEffect(() => {
    get<Detail>(`/files/${id}`).then(x => { setD(x); setError(null); }).catch(e => setError((e as Error).message));
    get<Collections>('/collections').then(c => setCols(c.user)).catch(() => {});
  }, [id]);
  const act = async (what: 'open' | 'reveal') => {
    try { await post(`${API}/files/${id}/${what}`, {}); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
  };
  if (error) return <EmptyState title="File not available">{error} <Link href="/filenex/search">Search</Link></EmptyState>;
  if (!d) return <EmptyState title="Reading…" />;
  const f = d.file;
  return (
    <>
      <div className="project-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill tone="muted">{TYPE_LABEL[f.fileType]}</Pill>
            {d.versions && <span className={`pill ${d.versions.latestId === f.id ? 'pill-ok' : 'pill-muted'}`}>{d.versions.latestId === f.id ? 'Likely latest version' : 'Older version'}</span>}
            {d.duplicate && <span className="pill pill-warn">{d.duplicate.kind === 'exact' ? 'Exact duplicate exists' : 'Possible duplicate'}</span>}
            {!d.exists && <span className="pill pill-bad">Missing on disk</span>}
          </div>
          <h2 className="context-title" style={{ marginTop: 10, wordBreak: 'break-word' }}>{f.name}</h2>
          <p className="path" style={{ marginTop: 6 }} title={f.path}>{f.path}</p>
        </div>
        <div className="actions">
          <button className="btn btn-ink" onClick={() => act('open')} disabled={!d.exists}><Icon name="external" size={13} />Open</button>
          <button className="btn btn-line" onClick={() => act('reveal')} disabled={!d.exists}><Icon name="folder" size={14} />Reveal in folder</button>
          <button className="btn btn-line" onClick={() => { navigator.clipboard?.writeText(f.path); setToast({ tone: 'ok', text: 'Path copied.' }); }}><Icon name="copy" size={13} />Copy path</button>
        </div>
      </div>
      <div className="bento">
        <article className="tile span-4">
          <p className="eyebrow">Details</p>
          <dl className="kv">
            <dt>Type</dt><dd>{TYPE_LABEL[f.fileType]}{f.extension ? ` · .${f.extension}` : ''}</dd>
            <dt>Size</dt><dd>{f.sizeBytes ? (f.sizeBytes < 1024 ** 2 ? `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB` : fmtBytes(f.sizeBytes)) : '—'}</dd>
            <dt>Modified</dt><dd>{new Date(f.modifiedAt).toLocaleString()}</dd>
            {f.createdAt && <><dt>Created</dt><dd>{new Date(f.createdAt).toLocaleString()}</dd></>}
            <dt>Indexed</dt><dd>{since(f.indexedAt, now)}</dd>
          </dl>
        </article>
        <article className="tile span-4">
          <p className="eyebrow"><Icon name="history" size={13} /> Related work</p>
          {d.contexts.length || d.project ? (
            <dl className="kv">
              {d.contexts.map(c => <Fragment key={c.id}><dt>WorkNEX</dt><dd><Link href={`/worknex/contexts/${c.id}`} style={{ color: 'inherit' }}>{c.title}</Link></dd></Fragment>)}
              {d.project && <><dt>DevNEX</dt><dd><Link href={`/devnex/projects/${d.project.id}`} style={{ color: 'inherit' }}>{d.project.name}</Link></dd></>}
            </dl>
          ) : <p className="fine">Not linked to a WorkNEX context or DevNEX project yet.</p>}
          <AddToCollection fileId={f.id} cols={cols} inCols={d.collections} setToast={setToast} onAdded={() => get<Detail>(`/files/${id}`).then(setD)} />
        </article>
        <article className="tile span-4">
          <p className="eyebrow">Duplicate status</p>
          {d.duplicate ? <>
            <p className="fine" style={{ marginTop: 0 }}>{d.duplicate.reasons.join(' · ')}</p>
            <ul className="feed">{d.duplicate.files.filter(x => x.id !== f.id).map(x => <li key={x.id}><Link href={`/filenex/files/${x.id}`} style={{ color: 'inherit' }} title={x.path}>{x.name}</Link><span className="fine" style={{ margin: 0 }}>{x.parentPath.split(/[\\/]/).pop()}</span></li>)}</ul>
            <p className="fine">FileNEX never deletes files. Compare them, then decide in Finder/Explorer.</p>
          </> : <p className="fine" style={{ marginTop: 0 }}>No duplicates found.</p>}
        </article>

        <article className="tile span-7">
          <p className="eyebrow">Related files</p>
          {d.related.length ? <div className="fx-list">{d.related.map(r => <FileRow key={r.file.id} f={r.file} now={now} extra={<small className="fine" style={{ margin: '2px 0 0', whiteSpace: 'normal' }}>{r.reasons.join(' · ')}</small>} />)}</div>
            : <p className="fine">No strongly related files. Relationships come from WorkNEX contexts, collections, similar names and files changed together.</p>}
        </article>
        <article className="tile span-5">
          <p className="eyebrow">Possible versions</p>
          {d.versions ? <>
            <div className="fx-list">{d.versions.files.map(v => (
              <div className="fx-row" key={v.id}>
                <Link href={`/filenex/files/${v.id}`} className="fx-main"><span style={{ minWidth: 0 }}><b>{v.name}{v.id === f.id ? ' (this file)' : ''}</b><small className="fine" style={{ margin: 0 }}>{when(v.modifiedAt, now)}</small></span></Link>
                {v.id === d.versions!.latestId && <span className="pill pill-ok">Likely latest</span>}
              </div>
            ))}</div>
            <p className="fine">{d.versions.reasons.slice(2).join(' ')}</p>
          </> : <p className="fine">No other versions found.</p>}
        </article>
      </div>
    </>
  );
}

function AddToCollection({ fileId, cols, inCols, setToast, onAdded }: { fileId: string; cols: Collections['user']; inCols: { id: string; name: string }[]; setToast: (t: Toasty) => void; onAdded: () => void }) {
  const [pick, setPick] = useState('');
  const avail = cols.filter(c => !inCols.some(x => `user:${x.id}` === c.id));
  return (
    <div style={{ marginTop: 14 }}>
      {!!inCols.length && <p className="fine" style={{ marginTop: 0 }}>In: {inCols.map(c => c.name).join(', ')}</p>}
      {avail.length ? (
        <div className="add-row">
          <select className="select" value={pick} onChange={e => setPick(e.target.value)} aria-label="Collection"><option value="">Add to collection…</option>{avail.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="btn btn-line btn-sm" disabled={!pick} onClick={async () => {
            try { await post(`${API}/collections/${encodeURIComponent(pick.replace(/^user:/, ''))}/items`, { fileId }); setToast({ tone: 'ok', text: 'Added — the file itself stays where it is.' }); setPick(''); onAdded(); }
            catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
          }}>Add</button>
        </div>
      ) : <p className="fine">{cols.length ? '' : <>Create a collection in <Link href="/filenex/collections">Collections</Link> to group files without moving them.</>}</p>}
    </div>
  );
}

/* ───────────────────────── Collections ───────────────────────── */
function CollectionsPage({ setToast }: { setToast: (t: Toasty) => void }) {
  const now = useNow();
  const [c, setC] = useState<Collections | null>(null);
  const [name, setName] = useState('');
  const load = useCallback(() => get<Collections>('/collections').then(setC).catch(() => setC({ work: [], projects: [], user: [] })), []);
  useEffect(() => { load(); }, [load]);
  const create = async () => {
    try { await post(`${API}/collections`, { name }); setName(''); setToast({ tone: 'ok', text: 'Collection created. Add files from any file’s page.' }); load(); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
  };
  if (!c) return <EmptyState title="Loading…" />;
  return (
    <div className="bento">
      <article className="tile span-6">
        <p className="eyebrow"><Icon name="history" size={13} /> Work contexts (WorkNEX)</p>
        {c.work.length ? <ul className="feed">{c.work.map(w => <li key={w.id}><Link href={`/filenex/collections/${encodeURIComponent(w.id)}`} style={{ color: 'inherit' }}><b>{w.name}</b></Link><span className="fine" style={{ margin: 0 }}>{w.files} files · {since(w.lastActiveAt, now)}</span></li>)}</ul>
          : <p className="fine">No WorkNEX context has files inside your indexed folders yet.</p>}
      </article>
      <article className="tile span-6">
        <p className="eyebrow"><Icon name="code" size={13} /> Projects (DevNEX)</p>
        {c.projects.length ? <ul className="feed">{c.projects.map(p => (
          <li key={p.id}>{p.indexed ? <Link href={`/filenex/collections/${encodeURIComponent(p.id)}`} style={{ color: 'inherit' }}><b>{p.name}</b></Link> : <b style={{ color: 'var(--muted)' }}>{p.name}</b>}
            <span className="fine" style={{ margin: 0 }}>{p.indexed ? `${nf(p.files)} files · ${p.recent} recent` : 'Not indexed — folder not added'}</span></li>
        ))}</ul> : <p className="fine">No DevNEX projects.</p>}
        <p className="fine">A DevNEX project is only indexed if its folder is inside a location you added here.</p>
      </article>
      <article className="tile span-12">
        <div className="tile-head"><div><p className="eyebrow">Your collections</p><h3>Logical groups — files never move</h3></div></div>
        <div className="add-row" style={{ marginBottom: 12 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Q4 ISO29110" aria-label="Collection name" onKeyDown={e => e.key === 'Enter' && name.trim() && create()} />
          <button className="btn btn-ink" disabled={!name.trim()} onClick={create}><Icon name="plus" size={14} />New collection</button>
        </div>
        {c.user.length ? <ul className="feed">{c.user.map(u => <li key={u.id}><Link href={`/filenex/collections/${encodeURIComponent(u.id)}`} style={{ color: 'inherit' }}><b>{u.name}</b></Link><span className="fine" style={{ margin: 0 }}>{u.files} file{u.files === 1 ? '' : 's'}</span></li>)}</ul>
          : <p className="fine">No collections yet.</p>}
      </article>
    </div>
  );
}

function CollectionPage({ id, setToast, onChanged }: { id: string; setToast: (t: Toasty) => void; onChanged: () => void }) {
  const now = useNow();
  const router = useRouter();
  const [c, setC] = useState<CollectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => get<CollectionView>(`/collections/${encodeURIComponent(id)}`).then(setC).catch(e => setError((e as Error).message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <EmptyState title="Collection not available">{error}</EmptyState>;
  if (!c) return <EmptyState title="Loading…" />;
  const userId = c.kind === 'user' ? id.replace(/^user:/, '') : null;
  return (
    <>
      <div className="project-head">
        <div><p className="eyebrow">{c.kind === 'context' ? 'WorkNEX context' : c.kind === 'project' ? 'DevNEX project' : 'Your collection'}</p><h2 className="context-title">{c.name}</h2>
          <p className="fine">{c.total} file{c.total === 1 ? '' : 's'}{Object.keys(c.byType).length ? ` · ${Object.entries(c.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${TYPE_LABEL[t as FileType]} ${n}`).join(' · ')}` : ''}</p></div>
        {userId && <div className="actions"><button className="btn btn-line" onClick={async () => { await call('DELETE', `/collections/${userId}`); setToast({ tone: 'ok', text: 'Collection deleted. Files are untouched.' }); onChanged(); router.push('/filenex/collections'); }}>Delete collection</button></div>}
      </div>
      {c.note && <div className="notice"><Icon name="lock" size={16} /><div>{c.note}</div></div>}
      <div className="fx-list table">
        {c.files.length ? c.files.map(f => <FileRow key={f.id} f={f} now={now} right={userId ? <button className="btn btn-ghost btn-sm" onClick={async () => { await call('DELETE', `/collections/${userId}/items/${f.id}`); load(); }}>Remove</button> : undefined} />)
          : <EmptyState title="No files">{c.kind === 'user' ? 'Add files from a file’s page.' : 'Nothing indexed matches this yet.'}</EmptyState>}
      </div>
    </>
  );
}

/* ───────────────────────── Versions & duplicates ───────────────────────── */
function VersionsPage() {
  const now = useNow();
  const [groups, setGroups] = useState<VersionGroup[] | null>(null);
  useEffect(() => { get<VersionGroup[]>('/versions').then(setGroups).catch(() => setGroups([])); }, []);
  if (!groups) return <EmptyState title="Loading…" />;
  return (
    <>
      <p className="fine section-note">Files that look like versions of each other (final, v2, revB, copy, dates…) in the same place. “Likely latest” is the most recently modified — a hint, not a certainty.</p>
      {groups.length ? groups.slice(0, 100).map(g => (
        <article className="tile" key={g.key} style={{ marginBottom: 12 }}>
          <div className="tile-head" style={{ marginBottom: 6 }}><div><p className="eyebrow">Possible version group · {g.files.length} files</p><h3 style={{ fontSize: 17 }}>{g.label}</h3></div></div>
          <div className="fx-list">{g.files.map(f => <FileRow key={f.id} f={f} now={now} right={f.id === g.latestId ? <span className="pill pill-ok">Likely latest</span> : undefined} />)}</div>
          {g.reasons.length > 2 && <p className="fine">{g.reasons.slice(2).join(' ')}</p>}
        </article>
      )) : <div className="table"><EmptyState title="No version groups found">FileNEX looks for names that differ only by “final”, “v3”, “revB”, “copy” or dates.</EmptyState></div>}
    </>
  );
}

function DuplicatesPage() {
  const now = useNow();
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [kind, setKind] = useState<'All' | 'Exact' | 'Possible'>('All');
  useEffect(() => { get<DuplicateGroup[]>('/duplicates').then(setGroups).catch(() => setGroups([])); }, []);
  if (!groups) return <EmptyState title="Loading…" />;
  const list = groups.filter(g => kind === 'All' || g.kind === kind.toLowerCase());
  return (
    <>
      <div className="toolbar"><FilterChips options={['All', 'Exact', 'Possible'] as const} value={kind} onChange={setKind} counts={{ All: groups.length, Exact: groups.filter(g => g.kind === 'exact').length, Possible: groups.filter(g => g.kind === 'possible').length }} /></div>
      <p className="fine section-note">Informational only — FileNEX never deletes, moves or renames files. Exact = identical content (hashed only when sizes match). Possible = same name apart from “copy” or numbering.</p>
      {list.length ? list.slice(0, 100).map(g => (
        <article className="tile" key={g.key} style={{ marginBottom: 12 }}>
          <div className="tile-head" style={{ marginBottom: 6 }}><div><p className="eyebrow">{g.kind === 'exact' ? 'Exact duplicate' : 'Possible duplicate'} · {g.files.length} files</p><p className="fine" style={{ margin: 0 }}>{g.reasons.join(' · ')}</p></div></div>
          <div className="fx-list">{g.files.map(f => <FileRow key={f.id} f={f} now={now} extra={<small className="fine" style={{ margin: 0 }}>{f.sizeBytes < 1024 ** 2 ? `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB` : fmtBytes(f.sizeBytes)}</small>} />)}</div>
        </article>
      )) : <div className="table"><EmptyState title="No duplicates found" /></div>}
    </>
  );
}

/* ───────────────────────── Settings ───────────────────────── */
function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}><i /></button>;
}

function SettingsPage({ status, setToast, onChanged, openAdd, addPath, clearAddParam }: { status: Status; setToast: (t: Toasty) => void; onChanged: () => void; openAdd: boolean; addPath: string | null; clearAddParam: () => void }) {
  const now = useNow();
  const [s, setS] = useState<FilenexSettings | null>(null);
  const [adding, setAdding] = useState(false);
  const [initialPath, setInitialPath] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LocationStatus | null>(null);
  const [confirm, setConfirm] = useState<'rebuild' | 'clear' | null>(null);
  const [clearCols, setClearCols] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [newExt, setNewExt] = useState('');
  const load = useCallback(() => get<FilenexSettings>('/settings').then(setS).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (openAdd) { setInitialPath(addPath); setAdding(true); clearAddParam(); } }, [openAdd, addPath, clearAddParam]);
  const save = async (patch: Partial<FilenexSettings>, text?: string) => {
    try { await call('PUT', '/settings', patch); if (text) setToast({ tone: 'ok', text }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
    load(); onChanged();
  };
  const act = async (fn: () => Promise<unknown>, text: string) => { try { await fn(); setToast({ tone: 'ok', text }); } catch (e) { setToast({ tone: 'error', text: (e as Error).message }); } load(); onChanged(); };
  if (!s) return <EmptyState title="Loading settings…" />;
  return (
    <>
      <div className="tile-head" style={{ marginTop: 4, marginBottom: 10 }}>
        <div><p className="eyebrow" style={{ margin: 0 }}>Indexed locations</p><p className="fine" style={{ marginTop: 2 }}>No folder permission, no indexing. Only these folders are indexed — nothing outside them is ever recorded.</p></div>
        <span style={{ display: 'flex', gap: 8 }}>
          {status.paused ? <button className="btn btn-line" onClick={() => act(() => post(`${API}/index/resume`, {}), 'Indexing resumed.')}><Icon name="play" size={13} />Resume indexing</button>
            : <button className="btn btn-ghost" onClick={() => act(() => post(`${API}/index/pause`, {}), 'Indexing paused. Search keeps working.')}><Icon name="pause" size={13} />Pause FileNEX</button>}
          <button className="btn btn-ink" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add folder</button>
        </span>
      </div>
      <div className="table">
        {!status.locations.length ? <EmptyState title="FileNEX is not indexing any folders.">Choose only the locations you want FileNEX to use for file intelligence.</EmptyState> : status.locations.map(l => (
          <div className="tracked-row" key={l.id}>
            <span className="cell-app" style={{ minWidth: 0 }}><span className="app-icon"><Icon name="folder" size={16} /></span>
              <span style={{ minWidth: 0 }}><b>{l.label}</b><small className="mono" title={l.path}>{l.path}</small></span></span>
            <span><Pill tone={l.state === 'scanning' ? 'warn' : l.state === 'unavailable' || l.state === 'error' ? 'bad' : l.state === 'paused' ? 'muted' : 'ok'}>{l.state === 'scanning' ? 'Scanning' : l.state === 'paused' ? 'Paused' : l.state === 'unavailable' ? 'Unavailable' : l.state === 'error' ? 'Error' : 'Indexed'}</Pill></span>
            <span className="fine" style={{ margin: 0 }}>{l.state === 'scanning' ? `${nf(l.scanned)} files scanned…` : `${nf(l.files)} files`}{l.lastScanAt ? ` · last scan ${since(l.lastScanAt, now)}` : ''}{l.error ? ` · ${l.error}` : ''}</span>
            <span><button className="btn btn-ghost btn-sm" onClick={() => act(() => post(`${API}/locations/${l.id}/scan`, {}), `Scanning ${l.label}…`)} disabled={l.paused || status.paused}>Scan now</button></span>
            <span className="cell-actions">
              <button className="btn btn-line" onClick={() => act(() => call('PUT', `/locations/${l.id}`, { paused: !l.paused }), l.paused ? `${l.label} resumed.` : `${l.label} paused.`)}>{l.paused ? 'Resume' : 'Pause'}</button>
              <button className="btn btn-line" onClick={() => setRemoving(l)}>Remove…</button>
            </span>
          </div>
        ))}
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Indexing</p>
      <div className="settings">
        <Setting title="Metadata only" text="FileNEX indexes names, folders, sizes, dates and types. File contents are not read — except hashing files of identical size to confirm exact duplicates.">
          <span className="chip chip-local"><Icon name="lock" size={13} />Metadata only</span>
        </Setting>
        <Setting title="Scan frequency" text="How often indexed folders are re-checked. Changes are also picked up by watching the folders.">
          <select className="select" value={s.scanEveryMinutes} onChange={e => save({ scanEveryMinutes: Number(e.target.value) })} aria-label="Scan frequency">
            <option value={15}>Every 15 minutes</option><option value={60}>Every hour</option><option value={360}>Every 6 hours</option><option value={1440}>Daily</option><option value={0}>Only when I ask</option>
          </select>
        </Setting>
        <Setting title="Watch folders for changes" text="Re-scan a folder shortly after something inside it changes.">
          <Switch on={s.watchChanges} label="Watch folders" onChange={v => save({ watchChanges: v })} />
        </Setting>
        <Setting title="Back off when the machine is busy" text="Uses the shared system monitor (memory pressure, CPU): background indexing slows down or waits.">
          <Switch on={s.deferUnderPressure} label="Back off when busy" onChange={v => save({ deferUnderPressure: v })} />
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Exclusions</p>
      <div className="settings">
        <Setting title="Ignored folders" text="Never walked, in every location (developer folders by default).">
          <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
            <div className="tags" style={{ justifyContent: 'flex-start' }}>{s.ignoredFolders.map(x => <span className="tag tag-soft" key={x}>{x}<button aria-label={`Stop ignoring ${x}`} onClick={() => save({ ignoredFolders: s.ignoredFolders.filter(y => y !== x) })}><Icon name="close" size={13} /></button></span>)}</div>
            <div className="add-row"><input value={newFolder} onChange={e => setNewFolder(e.target.value)} placeholder="Folder name" aria-label="Folder to ignore" />
              <button className="btn btn-line" disabled={!newFolder.trim()} onClick={() => { save({ ignoredFolders: [...s.ignoredFolders, newFolder.trim()] }); setNewFolder(''); }}>Add</button></div>
          </div>
        </Setting>
        <Setting title="Ignored extensions" text="Files with these extensions are skipped.">
          <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
            <div className="tags" style={{ justifyContent: 'flex-start' }}>{s.ignoredExtensions.map(x => <span className="tag tag-soft" key={x}>.{x}<button aria-label={`Stop ignoring ${x}`} onClick={() => save({ ignoredExtensions: s.ignoredExtensions.filter(y => y !== x) })}><Icon name="close" size={13} /></button></span>)}</div>
            <div className="add-row"><input value={newExt} onChange={e => setNewExt(e.target.value.replace(/^\*?\./, ''))} placeholder="e.g. tmp" aria-label="Extension to ignore" />
              <button className="btn btn-line" disabled={!newExt.trim()} onClick={() => { save({ ignoredExtensions: [...s.ignoredExtensions, newExt.trim()] }); setNewExt(''); }}>Add</button></div>
          </div>
        </Setting>
        <Setting title="Skip sensitive files" text="Names like .env, credentials, secrets, password, private key, id_rsa and .pem/.p12 files are not indexed at all — not even their names.">
          <Switch on={s.excludeSensitive} label="Skip sensitive files" onChange={v => save({ excludeSensitive: v }, v ? 'Sensitive files are skipped.' : 'Sensitive file names will be indexed on the next scan.')} />
        </Setting>
      </div>

      <p className="eyebrow" style={{ marginTop: 28 }}>Privacy</p>
      <div className="settings">
        <Setting title="Index file contents" text="Not available in this version. FileNEX searches metadata only and never reads documents.">
          <Switch on={false} label="Index content" onChange={() => {}} disabled />
        </Setting>
        <Setting title="Hidden files" text="Files and folders starting with a dot are skipped unless you turn this on.">
          <Switch on={s.includeHidden} label="Include hidden files" onChange={v => save({ includeHidden: v })} />
        </Setting>
      </div>

      <StorageSettingsSection setToast={setToast} />

      <p className="eyebrow" style={{ marginTop: 28 }}>Index storage</p>
      <div className="settings">
        <Setting title="Index size" text={`${nf(status.indexedFiles)} files · ${fmtBytes(status.indexBytes)} on disk (apps/workbench-api/.filenex/index.sqlite)`}><span /></Setting>
        <Setting title="Rebuild index" text="Re-creates FileNEX’s metadata from your indexed folders. Folder permissions, settings and collections are kept. Your files are not touched.">
          <button className="btn btn-line" onClick={() => setConfirm('rebuild')}>Rebuild…</button>
        </Setting>
        <Setting title="Clear FileNEX index" text="Deletes FileNEX’s index only. Your actual files are never deleted, moved or changed.">
          <button className="btn btn-line" onClick={() => setConfirm('clear')}>Clear index…</button>
        </Setting>
      </div>

      {adding && <AddFolderDialog initialPath={initialPath} onClose={() => { setAdding(false); setInitialPath(null); }} onAdded={label => { setAdding(false); setToast({ tone: 'ok', text: `Indexing “${label}”…` }); onChanged(); }} setToast={setToast} />}
      {removing && (
        <Modal onClose={() => setRemoving(null)}>
          <p className="eyebrow">Remove folder</p>
          <h2 className="h2">Stop indexing “{removing.label}”?</h2>
          <p>FileNEX stops scanning it immediately. What should happen to the {nf(removing.files)} file records it already has?</p>
          <p className="fine">Either way, the files in the folder are not touched.</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn-line" onClick={() => { act(() => call('DELETE', `/locations/${removing.id}?deleteIndex=false`), `Stopped indexing ${removing.label}. Existing records kept.`); setRemoving(null); }}>Keep index data</button>
            <button className="btn btn-danger" onClick={() => { act(() => call('DELETE', `/locations/${removing.id}?deleteIndex=true`), `Stopped indexing ${removing.label} and deleted its FileNEX records.`); setRemoving(null); }}>Remove &amp; delete index data</button>
          </div>
        </Modal>
      )}
      {confirm === 'rebuild' && (
        <Modal onClose={() => setConfirm(null)}>
          <p className="eyebrow">Rebuild index</p><h2 className="h2">Rebuild the FileNEX index?</h2>
          <p>FileNEX deletes its metadata and scans your indexed folders again. Folder permissions, settings and collections stay. <b>No file is changed.</b></p>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button><button className="btn btn-ink" onClick={() => { act(() => post(`${API}/index/rebuild`, { confirmed: true }), 'Rebuilding the index…'); setConfirm(null); }}>Rebuild</button></div>
        </Modal>
      )}
      {confirm === 'clear' && (
        <Modal onClose={() => setConfirm(null)}>
          <p className="eyebrow tone-text-critical">Clear FileNEX index</p><h2 className="h2">Delete FileNEX’s index?</h2>
          <p>This deletes <b>only FileNEX’s own metadata</b>. Your actual files are not deleted, moved or changed. Indexed folders stay approved and are scanned again on the next scan unless you pause FileNEX.</p>
          <label className="resume-item" style={{ marginTop: 12 }}><input type="checkbox" checked={clearCols} onChange={e => setClearCols(e.target.checked)} /><span><b>Also delete my collections</b><small>Kept unless you tick this.</small></span></label>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button><button className="btn btn-danger" onClick={() => { act(() => call('DELETE', `/index?confirmed=true&includeCollections=${clearCols}`), 'FileNEX index cleared. Your files are untouched.'); setConfirm(null); }}>Clear index</button></div>
        </Modal>
      )}
    </>
  );
}

/** Folder picker: browse sub-folder names (nothing is indexed by browsing) or type a path. */
function AddFolderDialog({ initialPath, onClose, onAdded, setToast }: { initialPath?: string | null; onClose: () => void; onAdded: (label: string) => void; setToast: (t: Toasty) => void }) {
  const [view, setView] = useState<{ path: string; parent: string | null; dirs: { name: string; path: string; indexed: boolean }[]; broad: boolean } | null>(null);
  const [typed, setTyped] = useState(initialPath ?? '');
  const [busy, setBusy] = useState(false);
  const [broadAsk, setBroadAsk] = useState<string | null>(null);
  const browse = useCallback((p?: string) => get<typeof view>(`/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`).then(setView).catch(e => setToast({ tone: 'error', text: (e as Error).message })), [setToast]);
  useEffect(() => { browse(initialPath ?? undefined); }, [browse, initialPath]);
  const add = async (path: string, confirmBroad = false) => {
    setBusy(true);
    try { const loc = await post<{ label: string }>(`${API}/locations`, { path, confirmBroad }); onAdded(loc.label); }
    catch (e) { const m = (e as Error).message; if (/broad folder/.test(m)) setBroadAsk(path); else setToast({ tone: 'error', text: m }); }
    finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} busy={busy}>
      <div className="modal-wide">
        <p className="eyebrow">Add folder</p>
        <h2 className="h2">Choose a folder FileNEX may index</h2>
        <p>Pick a specific work folder (e.g. Documents/Projects). Nothing outside it is recorded.{initialPath ? ' FileNEX will index its files and analyze its storage.' : ''}</p>
        {broadAsk ? <>
          <div className="notice" style={{ marginTop: 14 }}><Icon name="alert" size={16} /><div><b>That’s a broad folder.</b>“{broadAsk}” may contain personal files. A specific work folder is usually better. Index all of it anyway?</div></div>
          <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setBroadAsk(null)}>Choose another</button><button className="btn btn-ink" onClick={() => add(broadAsk, true)} disabled={busy}>Index all of it</button></div>
        </> : <>
          <div className="add-row" style={{ marginTop: 12 }}>
            <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="~/Documents/Projects" aria-label="Folder path" onKeyDown={e => e.key === 'Enter' && typed.trim() && add(typed.trim())} />
            <button className="btn btn-line" disabled={!typed.trim() || busy} onClick={() => add(typed.trim())}>Add</button>
          </div>
          {view && <>
            <p className="fine" style={{ marginBottom: 4 }}>Browse: <span className="mono">{view.path}</span></p>
            <ul className="resume-list">
              {view.parent && <li><button className="palette-item" onClick={() => browse(view.parent!)}><Icon name="arrow" size={14} />..</button></li>}
              {view.dirs.map(d => (
                <li key={d.path} className="fx-dir">
                  <button className="palette-item" onClick={() => browse(d.path)}><Icon name="folder" size={14} />{d.name}{d.indexed && <small>indexed</small>}</button>
                  {!d.indexed && <button className="btn btn-line btn-sm" onClick={() => add(d.path)} disabled={busy}>Index this</button>}
                </li>
              ))}
              {!view.dirs.length && <li className="empty">No sub-folders.</li>}
            </ul>
          </>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            {view && !view.dirs.some(d => d.indexed && d.path === view.path) && <button className="btn btn-ink" onClick={() => add(view.path)} disabled={busy}>Index “{view.path.split(/[\\/]/).pop()}”</button>}
          </div>
        </>}
      </div>
    </Modal>
  );
}
