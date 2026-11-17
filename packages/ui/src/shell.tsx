'use client';
/** @jsxImportSource @nex/i18n */
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { ago } from './format';

/** Product wordmark: two-line block + two-line subtitle (MemNEX: "MEM / NEX", "System / Intelligence"). */
export function Wordmark({ top, bottom, sub, label, variant }: { top: string; bottom: string; sub: [string, string]; label: string; variant?: string }) {
  return (
    <div className="wordmark" aria-label={label}>
      <span className={variant ? `wordmark-block wordmark-${variant}` : 'wordmark-block'}>{top}<br />{bottom}</span>
      <span className="wordmark-sub">{sub[0]}<br />{sub[1]}</span>
    </div>
  );
}

export type NavItem<T extends string> = { id: T; label: string; icon: IconName; badge?: number };

/** Left navigation (becomes a top bar under 900px via CSS). */
export function Sidebar<T extends string>({ wordmark, items, active, onSelect, footer }: {
  wordmark: ReactNode; items: NavItem<T>[]; active: T; onSelect: (id: T) => void; footer: ReactNode;
}) {
  return (
    <aside className="sidebar">
      {wordmark}
      <nav aria-label="Main">
        {items.map(n => (
          <button key={n.id} className={active === n.id ? 'active' : ''} aria-current={active === n.id ? 'page' : undefined} onClick={() => onSelect(n.id)}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.badge && <em className="badge">{n.badge}</em>}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">{footer}</div>
    </aside>
  );
}

/** Sidebar footer: local-only chip + version/platform line. */
export function LocalFooter({ version, platform }: { version: string; platform: string }) {
  return (
    <>
      <span className="chip chip-local"><Icon name="lock" size={13} />Local only</span>
      <small>{version} · {platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform}</small>
    </>
  );
}

/** Page header: eyebrow + title on the left, live status + refresh on the right. */
export function Topbar({ eyebrow, title, updatedAt, offline, now, onRefresh, actions }: {
  eyebrow: ReactNode; title: string; updatedAt: string | null; offline: boolean; now: number; onRefresh?: () => void; actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      <div className="topbar-right">
        <span className={`live ${offline ? 'is-offline' : ''}`} aria-live="polite">
          <i />{offline ? 'Service unreachable — retrying' : updatedAt ? `Live · updated ${ago(updatedAt, now)}` : 'Connecting…'}
        </span>
        {onRefresh && <button className="btn btn-ghost" onClick={onRefresh}><Icon name="refresh" size={16} />Refresh</button>}
        {actions}
      </div>
    </header>
  );
}
