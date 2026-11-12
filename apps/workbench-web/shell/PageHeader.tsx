'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { Icon, Topbar, useNow } from '@nex/ui';
import { useWorkbench } from './context';

export type Crumb = { label: string; href?: string };

/** ⌘ on macOS, Ctrl elsewhere. Decided after mount so server and client markup match. */
function useModKey() {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setMod('⌘'); }, []);
  return mod;
}

/**
 * The shared top bar: NEX Workbench / Module / Page breadcrumb, page title, live status,
 * Search (Cmd/Ctrl+K) and the Local indicator. Same component on every page of every module.
 */
export function PageHeader({ crumbs, title, updatedAt, offline, onRefresh }: {
  crumbs: Crumb[]; title: string; updatedAt: string | null; offline: boolean; onRefresh?: () => void;
}) {
  const { openPalette, summary } = useWorkbench();
  // Privacy mode is visible everywhere, not only inside WorkNEX.
  const work = summary?.modules.find(m => m.id === 'worknex');
  const workPaused = work?.metrics.some(x => x.label === 'Tracking' && x.value === 'Paused');
  // Subtle "WorkNEX is observing your approved apps" indicator — never shown when nothing is tracked.
  const workTracking = !workPaused && work?.state !== 'not-configured' ? work?.metrics.find(x => x.label === 'Tracking')?.value : undefined;
  const now = useNow();
  const mod = useModKey();
  const trail: Crumb[] = [{ label: 'NEX Workbench', href: '/' }, ...crumbs];
  return (
    <Topbar
      eyebrow={
        <nav className="crumbs" aria-label="Breadcrumb">
          {trail.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              {i > 0 && <span className="sep" aria-hidden>/</span>}
              {c.href && i < trail.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span aria-current={i === trail.length - 1 ? 'page' : undefined}>{c.label}</span>}
            </Fragment>
          ))}
        </nav>
      }
      title={title}
      updatedAt={updatedAt}
      offline={offline}
      now={now}
      onRefresh={onRefresh}
      actions={
        <>
          <button className="search-trigger" onClick={openPalette} aria-label="Search and run commands">
            <Icon name="search" size={15} /><span className="label">Search</span><kbd>{mod} K</kbd>
          </button>
          {workTracking && <Link className="chip chip-tracking" href="/worknex/settings" title={`WorkNEX is tracking only the apps you approved (${workTracking}).`}><Icon name="history" size={13} /><span className="label">WorkNEX · {workTracking}</span></Link>}
          {workPaused && <Link className="chip chip-paused" href="/worknex" title="WorkNEX is paused — nothing is being recorded."><Icon name="pause" size={13} /><span className="label">WorkNEX paused</span></Link>}
          <span className="chip chip-local" title="Runs on this computer only. Nothing is sent to a cloud service.">
            <Icon name="lock" size={13} /><span className="label">Local</span>
          </span>
        </>
      }
    />
  );
}
