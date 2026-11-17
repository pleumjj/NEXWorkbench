'use client';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { EmptyState, Icon, Segmented, Setting, Toast, createPost, useToast } from '@nex/ui';
import { useWorkbench } from './context';
import { PageHeader } from './PageHeader';

type SettingsData = {
  preferences: { disabledModules: string[]; refresh: 'normal' | 'relaxed'; language: 'system' | 'en' | 'th' };
  modules: { id: string; name: string; description: string; route: string }[];
  version: string; platform: string;
  dataLocations: Record<string, string>;
  root: string;
  ports: { web: number; api: number };
  startedAt: string;
};

const post = createPost('NEX Workbench');

/** Workbench-wide settings. Module settings stay in /memnex/settings and /devnex/settings. */
export function WorkbenchSettings() {
  const { theme, setTheme, refreshSummary } = useWorkbench();
  const [data, setData] = useState<SettingsData | null>(null);
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useToast<{ tone: 'ok' | 'error'; text: string }>();

  const load = useCallback(async () => {
    try { const r = await fetch('/api/workbench/settings'); if (!r.ok) throw new Error(); setData(await r.json()); setOffline(false); }
    catch { setOffline(true); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (patch: Partial<SettingsData['preferences']>, message: string) => {
    try { await post('/api/workbench/settings', patch); setToast({ tone: 'ok', text: message }); load(); refreshSummary(); }
    catch (e) { setToast({ tone: 'error', text: (e as Error).message }); }
  };

  return (
    <>
      <PageHeader crumbs={[{ label: 'Settings' }]} title="Settings" updatedAt={data ? data.startedAt : null} offline={offline} onRefresh={load} />
      {!data ? <EmptyState title={offline ? 'The Workbench service isn’t answering.' : 'Loading settings…'}>{offline && <>Run <code>npm run dev</code> in the NEXWorkbench folder.</>}</EmptyState> : (
        <div className="settings">
          <Setting title="Language" text="Follow the operating system’s language, or choose English or Thai. Reports exported for Claude and timesheet CSV files stay in English.">
            <Segmented options={['system', 'en', 'th'] as const} value={data.preferences.language ?? 'system'} label={v => (v === 'system' ? 'Follow system' : v === 'en' ? 'English' : 'ไทย')}
              onChange={v => save({ language: v }, v === 'th' ? 'ภาษาไทย' : v === 'en' ? 'English' : 'Following the system language.')} />
          </Setting>
          <Setting title="Appearance" text="One theme for Home, MemNEX and DevNEX. Follow the system or choose a mode.">
            <Segmented options={['system', 'light', 'dark'] as const} value={theme} onChange={setTheme} />
          </Setting>
          <Setting title="Refresh behavior" text="Normal: memory and CPU every 3 s, processes and projects every 5 s. Relaxed polls three times less often — lighter on battery.">
            <Segmented options={['normal', 'relaxed'] as const} value={data.preferences.refresh}
              onChange={v => save({ refresh: v }, v === 'relaxed' ? 'Refreshing less often.' : 'Normal refresh restored.')} />
          </Setting>
          <Setting title="Enabled modules" text="A turned-off module disappears from the sidebar, Home and Attention. Its data and settings are kept.">
            <div style={{ display: 'grid', gap: 10 }}>
              {data.modules.map(m => {
                const on = !data.preferences.disabledModules.includes(m.id);
                return (
                  <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
                    <span><b>{m.name}</b> <span className="fine" style={{ margin: 0 }}>{m.description}</span></span>
                    <button className="switch" role="switch" aria-checked={on} aria-label={`${m.name} enabled`}
                      onClick={() => save({ disabledModules: on ? [...data.preferences.disabledModules, m.id] : data.preferences.disabledModules.filter(x => x !== m.id) }, `${m.name} ${on ? 'turned off' : 'turned on'}.`)}><i /></button>
                  </label>
                );
              })}
            </div>
          </Setting>
          <Setting title="Module settings" text="Protected apps, learned preferences, project folders and registered projects belong to each module.">
            <div className="tags">
              <Link className="btn btn-line" href="/memnex/settings">MemNEX settings</Link>
              <Link className="btn btn-line" href="/devnex/settings">DevNEX settings</Link>
            </div>
          </Setting>
          <Setting title="Local data location" text="Small JSON files on this computer. No database, no cloud sync. Delete a folder to reset that module.">
            <dl className="kv" style={{ maxWidth: 420 }}>
              {Object.entries(data.dataLocations).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono" title={v}>{v}</dd></Fragment>)}
            </dl>
          </Setting>
          <Setting title="Network" text={`The web app listens on 127.0.0.1:${data.ports.web}; the API on 127.0.0.1:${data.ports.api} is internal and only accepts requests from this app. Nothing is reachable from your network.`}>
            <span className="chip chip-local"><Icon name="lock" size={13} />Localhost only</span>
          </Setting>
          <Setting title="NEX Workbench" text={`Version ${data.version} · ${data.platform === 'darwin' ? 'macOS' : data.platform === 'win32' ? 'Windows' : data.platform} · ${data.root}`}>
            <span className="fine" style={{ margin: 0 }}>No telemetry · no account</span>
          </Setting>
        </div>
      )}
      {toast && <Toast tone={toast.tone} text={toast.text} />}
    </>
  );
}
