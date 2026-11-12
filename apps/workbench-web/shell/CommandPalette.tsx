'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NexCommand } from '@nex/shared';
import { Icon } from '@nex/ui';
import { useWorkbench } from './context';

/**
 * Cmd/Ctrl+K. The Workbench only routes: each command is a route a module published,
 * and the module decides what happens there. Commands are fetched fresh each time it opens.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { isEnabled } = useWorkbench();
  const [commands, setCommands] = useState<NexCommand[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    input.current?.focus();
    fetch('/api/workbench/commands').then(r => (r.ok ? r.json() : Promise.reject())).then(setCommands).catch(() => setFailed(true));
  }, []);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = commands ?? [];
    if (!words.length) return all.filter(c => !['Ports', 'Services', 'Projects'].includes(c.group)).slice(0, 40);
    return all
      .map(c => {
        const hay = `${c.title} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
        if (!words.every(w => hay.includes(w))) return null;
        // Title hits rank above keyword-only hits.
        const score = words.reduce((n, w) => n + (c.title.toLowerCase().includes(w) ? 2 : 1), 0) + (c.title.toLowerCase().startsWith(words[0]) ? 2 : 0);
        return { c, score };
      })
      .filter((x): x is { c: NexCommand; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(x => x.c);
  }, [commands, query]);
  // A typed query can always go to FileNEX search ("ISO29110 presentation", "excel edited yesterday").
  const fileSearch: NexCommand | null = query.trim().length >= 2 && isEnabled('filenex')
    ? { id: 'filenex.query', title: `Search files for “${query.trim()}”`, group: 'FileNEX', route: `/filenex/search?q=${encodeURIComponent(query.trim())}` } : null;
  const shown = useMemo(() => (fileSearch ? [...results, fileSearch] : results), [results, fileSearch?.route]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, [index]);

  const run = (c: NexCommand | undefined) => { if (!c) return; onClose(); router.push(c.route); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[index]); }
  };

  let lastGroup = '';
  return (
    <div className="scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal aria-label="Command palette" onClick={e => e.stopPropagation()} onKeyDown={onKey}>
        <label className="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search apps, projects, ports, commands…"
            aria-label="Search commands" role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={shown[index] ? `cmd-${index}` : undefined} />
        </label>
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {failed && <li className="empty">The Workbench service isn’t answering. Run <code>npm run dev</code>, then try again.</li>}
          {!failed && !commands && <li className="empty">Loading commands…</li>}
          {commands && !shown.length && <li className="empty">No command matches “{query}”.</li>}
          {shown.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {header && <p className="palette-group">{header}</p>}
                <button id={`cmd-${i}`} role="option" aria-selected={i === index} className={`palette-item ${i === index ? 'on' : ''}`}
                  onMouseMove={() => setIndex(i)} onClick={() => run(c)}>
                  {c.title}<small>{c.route}</small>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
      </div>
    </div>
  );
}
