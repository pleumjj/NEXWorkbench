'use client';
import { useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { fmtBytes } from './format';

/** Usage meter with threshold ticks (MemNEX: 70% Moderate / 85% High). */
export function Meter({ value, tone, label, ticks = [70, 85] }: { value: number; tone: string; label: string; ticks?: number[] }) {
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <i className={`fill tone-bg-${tone}`} style={{ width: `${Math.min(value, 100)}%` }} />
      {ticks.map(t => <span key={t} className="tick" style={{ left: `${t}%` }} />)}
    </div>
  );
}

/** Single-number tile. `warn` adds the orange edge. */
export function Stat({ label, value, detail, warn, className }: { label: string; value: string; detail: string; warn?: boolean; className?: string }) {
  return (
    <article className={`tile tile-stat ${warn ? 'is-warn' : ''}${className ? ` ${className}` : ''}`}>
      <p className="eyebrow">{label}</p>
      <p className="mid-num">{value}</p>
      <p className="fine">{detail}</p>
    </article>
  );
}

/** Status pill. Tones map to pill-* classes: review | protected | system | growth | normal | ok | warn | bad | muted. */
export function Pill({ tone, lock, title, children }: { tone: string; lock?: boolean; title?: string; children: ReactNode }) {
  return <span className={`pill pill-${tone}`} title={title}>{lock && <Icon name="lock" size={12} />}{children}</span>;
}

/** Settings row: title + explanation on the left, control on the right. */
export function Setting({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div><b>{title}</b><p>{text}</p></div>
      {children}
    </div>
  );
}

/** Before/after bar. */
export function Compare({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="compare">
      <span>{label}</span>
      <span className="bar"><i style={{ width: `${(value / max) * 100}%` }} /></span>
      <strong className="num">{fmtBytes(value)}</strong>
    </div>
  );
}

/** Modal with scrim. Clicking the scrim closes unless `busy`. */
export function Modal({ onClose, busy, children }: { onClose: () => void; busy?: boolean; children: ReactNode }) {
  return (
    <div className="scrim" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal onClick={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}

/** Confirmation dialog built on Modal (eyebrow, title, body, Cancel + action). */
export function ConfirmDialog({ eyebrow, eyebrowClass, title, children, confirmLabel, busyLabel, danger, busy, onCancel, onConfirm }: {
  eyebrow: string; eyebrowClass?: string; title: string; children: ReactNode; confirmLabel: string; busyLabel?: string;
  danger?: boolean; busy?: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <Modal onClose={onCancel} busy={busy}>
      <p className={`eyebrow${eyebrowClass ? ` ${eyebrowClass}` : ''}`}>{eyebrow}</p>
      <h2 className="h2">{title}</h2>
      {children}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={danger ? 'btn btn-danger' : 'btn btn-ink'} onClick={onConfirm} disabled={busy}>{busy && busyLabel ? busyLabel : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Toast({ tone, text, action }: { tone: 'ok' | 'error'; text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className={`toast toast-${tone}`} role="status">
      <span>{text}</span>
      {action && <button className="toast-action" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}

/** Theme segmented control. */
export function Segmented<T extends string>({ options, value, onChange, label = (v: T) => v[0].toUpperCase() + v.slice(1) }: {
  options: readonly T[]; value: T; onChange: (v: T) => void; label?: (v: T) => string;
}) {
  return (
    <div className="segmented">
      {options.map(o => <button key={o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>{label(o)}</button>)}
    </div>
  );
}

/** Search field with icon. */
export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="search">
      <Icon name="search" size={16} />
      <input placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} aria-label={placeholder} />
    </label>
  );
}

/** Filter chips with counts. */
export function FilterChips<T extends string>({ options, value, onChange, counts }: { options: readonly T[]; value: T; onChange: (v: T) => void; counts?: Partial<Record<T, number>> }) {
  return (
    <div className="chips" role="tablist" aria-label="Filter">
      {options.map(f => (
        <button key={f} role="tab" aria-selected={value === f} className={`chip ${value === f ? 'on' : ''}`} onClick={() => onChange(f)}>
          {f}{counts?.[f] != null && <span className="num">{counts[f]}</span>}
        </button>
      ))}
    </div>
  );
}

/** Real app icon when `src` loads; otherwise a glyph that says what kind of thing it is (never a letter monogram). */
const failedIcons = new Set<string>();
export function AppIcon({ src, kind = 'app' }: { src?: string; kind?: 'app' | 'system' | 'terminal' | 'container' | 'folder' }) {
  const [failed, setFailed] = useState(() => !src || failedIcons.has(src));
  if (kind === 'app' && !failed && src) {
    return <img className="app-icon app-icon-img" src={src} alt="" loading="lazy" onError={() => { failedIcons.add(src); setFailed(true); }} />;
  }
  const glyph = kind === 'system' ? 'M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z'
    : kind === 'terminal' ? 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3'
    : kind === 'container' ? 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8'
    : kind === 'folder' ? 'M3 7h7l2 2h9v10H3z'
    : 'M5 5h14v14H5zM5 9h14';
  return <span className="app-icon" aria-hidden><svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d={glyph} /></svg></span>;
}

/** Centered state for loading / unreachable service / empty lists. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><b>{title}</b>{children && <p>{children}</p>}</div>;
}
