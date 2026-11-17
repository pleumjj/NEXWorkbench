'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon, LocalFooter, Wordmark, useTheme } from '@nex/ui';
import { getLanguage, languageOf, setLanguage, type Language } from '@nex/i18n';
import { Ctx, type Badges, type WorkbenchContext, type WorkbenchSummary } from './context';
import { MODULES, moduleFor, sectionsOf } from './modules';
import { CommandPalette } from './CommandPalette';

/**
 * The NEX Workbench shell: one sidebar, one theme, one command palette, one summary poll.
 * Modules render inside it; they never own the chrome.
 */
export function WorkbenchShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '/';
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [offline, setOffline] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [badges, setBadgeMap] = useState<Record<string, Badges>>({});
  const [theme, setTheme] = useTheme('nex.theme');

  // UI language: the Workbench preference, or the operating system's language ("Follow system", the default).
  // The first render is English (same as the server render); the content remounts once the language is known.
  const [lang, setLang] = useState<Language>('en');
  const pref = summary?.preferences.language;
  useEffect(() => {
    const apply = (l: Language) => {
      setLanguage(l);
      document.documentElement.lang = l;
      try { localStorage.setItem('nex.lang', l); } catch { /* private mode */ }
      setLang(l);
    };
    try { const saved = localStorage.getItem('nex.lang'); if (!pref && (saved === 'th' || saved === 'en')) apply(saved); } catch { /* private mode */ }
    if (pref === 'en' || pref === 'th') apply(pref);
    else if (pref === 'system') fetch('/api/system/locale').then(r => r.json()).then(j => apply(languageOf(j.locale))).catch(() => apply(languageOf(navigator.language)));
  }, [pref]);

  const relaxed = summary?.preferences.refresh === 'relaxed';
  const every = useCallback((ms: number) => (relaxed ? ms * 3 : ms), [relaxed]);

  const refreshSummary = useCallback(async () => {
    try {
      const r = await fetch('/api/workbench/summary');
      if (!r.ok) throw new Error();
      setSummary(await r.json());
      setOffline(false);
    } catch { setOffline(true); }
  }, []);

  useEffect(() => {
    refreshSummary();
    const t = setInterval(refreshSummary, every(5000));
    return () => clearInterval(t);
  }, [refreshSummary, every]);

  // Cmd+K (macOS) / Ctrl+K (Windows) anywhere in the Workbench.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setBadges = useCallback((moduleId: string, b: Badges) => {
    setBadgeMap(cur => (JSON.stringify(cur[moduleId]) === JSON.stringify(b) ? cur : { ...cur, [moduleId]: b }));
  }, []);
  const isEnabled = useCallback((id: string) => !summary?.preferences.disabledModules.includes(id), [summary]);

  const ctx = useMemo<WorkbenchContext>(() => ({
    summary, offline, refreshSummary, theme, setTheme, openPalette: () => setPaletteOpen(true), every, setBadges, isEnabled, language: lang,
  }), [summary, offline, refreshSummary, theme, setTheme, every, setBadges, isEnabled, lang]);

  const current = moduleFor(pathname);
  const attentionOf = (name: string) => summary?.attention.filter(a => a.sourceModule === name && a.severity !== 'info').length || undefined;

  return (
    <Ctx.Provider value={ctx}>
      <main className="shell" key={lang} data-lang={getLanguage()}>
        <aside className="sidebar">
          <Link href="/" style={{ color: 'inherit', textDecoration: 'none' }}>
            <Wordmark top="NEX" bottom="WORK" sub={['Workbench', 'Local-first']} label="NEX Workbench" />
          </Link>
          <nav aria-label="Main">
            <Link href="/" className={pathname === '/' ? 'active' : ''} aria-current={pathname === '/' ? 'page' : undefined}>
              <Icon name="home" /><span>Home</span>
              {summary && summary.state !== 'Healthy' && pathname !== '/' && <em className="badge">{summary.attention.filter(a => a.severity !== 'info').length || '!'}</em>}
            </Link>
            <p className="nav-group">Tools</p>
            {MODULES.filter(m => isEnabled(m.id)).map(m => {
              const inside = current?.id === m.id;
              const section = inside ? sectionsOf(pathname, m.route)[0] ?? '' : null;
              return (
                <div key={m.id} style={{ display: 'contents' }}>
                  <Link href={m.route} className={inside ? 'in-module' : ''} aria-current={inside && section === '' ? 'page' : undefined}>
                    <Icon name={m.icon} /><span>{m.name}</span>
                    {!inside && attentionOf(m.name) && <em className="badge">{attentionOf(m.name)}</em>}
                  </Link>
                  {inside && m.sections.map(s => {
                    const active = section === s.slug;
                    const badge = badges[m.id]?.[s.slug || 'overview'];
                    return (
                      <Link key={s.slug} href={s.slug ? `${m.route}/${s.slug}` : m.route} className={`nav-sub ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
                        <Icon name={s.icon} size={16} /><span>{s.label}</span>
                        {!!badge && <em className="badge">{badge}</em>}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
            <p className="nav-group" aria-hidden>&nbsp;</p>
            <Link href="/settings" className={pathname === '/settings' ? 'active' : ''} aria-current={pathname === '/settings' ? 'page' : undefined}>
              <Icon name="settings" /><span>Settings</span>
            </Link>
          </nav>
          <div className="sidebar-foot">
            <LocalFooter version={`v${summary?.version ?? '0.3.0'}`} platform={summary?.platform ?? ''} />
          </div>
        </aside>

        <section className="content">{children}</section>
      </main>
      {paletteOpen && <CommandPalette key={lang} onClose={() => setPaletteOpen(false)} />}
    </Ctx.Provider>
  );
}
