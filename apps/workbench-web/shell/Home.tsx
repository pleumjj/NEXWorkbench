'use client';
import Link from 'next/link';
import type { AttentionItem, ModuleStatus } from '@nex/shared';
import { EmptyState, Icon, Pill, since, useNow } from '@nex/ui';
import { useWorkbench } from './context';
import { PageHeader } from './PageHeader';
import { MODULES } from './modules';

const STATE_TONE = { Healthy: 'healthy', Attention: 'moderate', Critical: 'critical' } as const;
const MODULE_PILL: Record<ModuleStatus['state'], { tone: string; label: string }> = {
  healthy: { tone: 'ok', label: 'Healthy' }, attention: { tone: 'warn', label: 'Attention' },
  critical: { tone: 'bad', label: 'Critical' }, unavailable: { tone: 'muted', label: 'Unavailable' },
  'not-configured': { tone: 'muted', label: 'Not configured' },
};

/** Workbench Home: what is happening on this machine, and what needs attention. */
export function Home() {
  const { summary, offline, refreshSummary, openPalette, isEnabled } = useWorkbench();
  const now = useNow();

  if (!summary) return (
    <div className="boot boot-inline">
      {offline ? <>
        <h1>NEX Workbench can’t reach its local service.</h1>
        <p>Run <code>npm run dev</code> in the NEXWorkbench folder, then this page reconnects on its own.</p>
      </> : <p>Reading your machine…</p>}
    </div>
  );

  const tone = STATE_TONE[summary.state];
  const top = summary.attention.find(a => a.severity !== 'info');
  const needs = summary.attention.filter(a => a.severity !== 'info');

  return (
    <>
      <PageHeader crumbs={[{ label: 'Home' }]} title="Home" updatedAt={summary.updatedAt} offline={offline} onRefresh={refreshSummary} />

      <div className="quick" aria-label="Quick actions">
        {isEnabled('memnex') && <Link className="btn btn-line" href="/memnex/cleanup"><Icon name="cleanup" size={15} />Smart Cleanup</Link>}
        {isEnabled('memnex') && <Link className="btn btn-line" href="/memnex/processes?filter=high"><Icon name="memory" size={15} />High-memory apps</Link>}
        {isEnabled('devnex') && <Link className="btn btn-line" href="/devnex/ports"><Icon name="ports" size={15} />Ports in use</Link>}
        {isEnabled('devnex') && <Link className="btn btn-line" href="/devnex/projects?add=1"><Icon name="plus" size={15} />Add project</Link>}
        {isEnabled('worknex') && <Link className="btn btn-line" href="/worknex?where=1"><Icon name="where" size={15} />Where was I?</Link>}
        {isEnabled('filenex') && <Link className="btn btn-line" href="/filenex/search"><Icon name="file" size={15} />Find a file</Link>}
        <button className="btn btn-ghost" onClick={openPalette}><Icon name="search" size={15} />Search everything</button>
      </div>

      <div className="bento">
        {/* ── Workspace status ── */}
        <article className={`tile tile-status span-5 tone-${tone}`}>
          <p className="eyebrow">Workspace status</p>
          <h2 className="state-word" style={{ marginTop: 'auto' }}>{summary.state}</h2>
          <p className="insight-headline">{summary.statusText}</p>
          <ul className="evidence" aria-label="Modules">
            {summary.modules.map(m => <li key={m.id}>{m.name}: {MODULE_PILL[m.state].label}</li>)}
          </ul>
          <div className="tile-foot" style={{ marginTop: 20 }}>
            {top?.action
              ? <Link className="btn btn-ink" href={top.action}>{top.actionLabel ?? 'Review'} · {top.title} <Icon name="arrow" size={16} /></Link>
              : <span className="no-action"><Icon name="check" size={16} />No action needed</span>}
          </div>
        </article>

        {/* ── Attention Center ── */}
        <article className="tile span-7">
          <div className="tile-head">
            <div><p className="eyebrow">Attention</p><h3>{needs.length ? `${needs.length} item${needs.length === 1 ? '' : 's'} need${needs.length === 1 ? 's' : ''} review` : 'Nothing needs your attention'}</h3></div>
          </div>
          <div className="attention-list">
            {summary.attention.length
              ? summary.attention.slice(0, 6).map(a => <AttentionRow key={a.id} item={a} />)
              : <EmptyState title="All clear">Each module checks its own domain — memory pressure, port conflicts, crashed services, missing variables.</EmptyState>}
            {summary.attention.length > 6 && <p className="fine">+ {summary.attention.length - 6} more in the modules.</p>}
          </div>
        </article>

        {/* ── My NEX ── */}
        {summary.modules.map(m => <ModuleCard key={m.id} m={m} count={summary.modules.length} />)}

        {/* ── Continue working (WorkNEX; DevNEX fallback when WorkNEX is off) ── */}
        {(isEnabled('worknex') || isEnabled('devnex')) && (
          <article className="tile span-7">
            <div className="tile-head">
              <div><p className="eyebrow">Continue working</p><h3>{summary.continueWorking.length ? 'Pick up where you left off' : 'Nothing to resume yet'}</h3></div>
              <Link className="btn btn-ghost" href={isEnabled('worknex') ? '/worknex' : '/devnex/projects'}>{isEnabled('worknex') ? 'WorkNEX' : 'All projects'} <Icon name="arrow" size={16} /></Link>
            </div>
            {summary.continueWorking.length ? summary.continueWorking.map(p => {
              const web = p.services.find(r => r.port);
              return (
                <div className="continue" key={p.id}>
                  <div style={{ minWidth: 0 }}>
                    <b>{p.title}</b>
                    <p className="fine" style={{ margin: '2px 0 0' }}>{p.isActive ? 'Active now' : p.lastActiveAt ? `Last active ${since(p.lastActiveAt, now)}` : 'Running now'}{p.subtitle ? ` · ${p.subtitle}` : ''}</p>
                  </div>
                  <dl className="kv">
                    {p.branch && <><dt>Branch</dt><dd>{p.branch}</dd></>}
                    {!!p.services.length && <><dt>Running</dt><dd>{p.services.map(r => `${r.name}${r.port ? ` :${r.port}` : ''}`).join(', ')}</dd></>}
                    {!p.branch && !p.services.length && p.path && <><dt>Folder</dt><dd className="path">{p.path}</dd></>}
                  </dl>
                  <span className="cell-actions">
                    {web?.port && <a className="btn btn-line" href={`http://localhost:${web.port}`} target="_blank" rel="noreferrer"><Icon name="external" size={13} />:{web.port}</a>}
                    <Link className="btn btn-ink" href={p.route}>Resume</Link>
                  </span>
                </div>
              );
            }) : <EmptyState title="Nothing to resume">{isEnabled('worknex') ? 'WorkNEX remembers work only in the apps you choose to track. Choose them in WorkNEX › Settings.' : 'Projects appear here while their dev servers run.'}</EmptyState>}
          </article>
        )}

        {/* ── Recent activity ── */}
        <article className={`tile ${isEnabled('worknex') || isEnabled('devnex') ? 'span-5' : 'span-12'}`}>
          <p className="eyebrow">Recent activity</p>
          <h3 style={{ fontSize: 18, marginBottom: 10 }}>This session</h3>
          {summary.activity.length ? (
            <ul className="feed">
              {summary.activity.slice(0, 8).map(a => (
                <li key={a.id}><span><span className="src">{a.sourceModule}</span> · {a.title}</span><time dateTime={a.timestamp}>{since(a.timestamp, now)}</time></li>
              ))}
            </ul>
          ) : <EmptyState title="Quiet so far">Cleanups, service starts and stops, crashes and port conflicts show up here. Kept in memory only.</EmptyState>}
        </article>
      </div>
    </>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <div className={`issue sev-${item.severity}`}>
      <i aria-hidden />
      <div>
        <span className="src">{item.sourceModule}</span>
        <b>{item.title}</b>
        <p>{item.description}</p>
      </div>
      {item.action ? <Link className="btn btn-line" href={item.action}>{item.actionLabel ?? 'Review'}</Link> : <span />}
    </div>
  );
}

function ModuleCard({ m, count }: { m: ModuleStatus; count: number }) {
  const pill = MODULE_PILL[m.state];
  const icon = MODULES.find(x => x.id === m.id)?.icon ?? 'overview';
  return (
    <article className={`tile ${count === 3 ? 'span-4' : 'span-6'} module-card`}>
      <div className="tile-head">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="app-icon"><Icon name={icon} size={16} /></span>
          <div><h3>{m.name}</h3><p className="fine" style={{ margin: 0 }}>{m.tagline}</p></div>
        </div>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      <p className="headline">{m.headline}</p>
      {!!m.metrics.length && (
        <dl className="spec">
          {m.metrics.map(x => <div key={x.label}><dt>{x.label}</dt><dd>{x.value}</dd></div>)}
        </dl>
      )}
      <div className="tile-foot">
        <span className="fine" style={{ margin: 0 }}>{m.detail ?? ''}</span>
        {m.state === 'not-configured' && (m.id === 'worknex' || m.id === 'filenex')
          ? <Link className="btn btn-line" href={`${m.route}/settings?add=1`}>{m.id === 'worknex' ? 'Choose apps' : 'Choose folders'} <Icon name="arrow" size={16} /></Link>
          : <Link className="btn btn-ink" href={m.route}>Open <Icon name="arrow" size={16} /></Link>}
      </div>
    </article>
  );
}
