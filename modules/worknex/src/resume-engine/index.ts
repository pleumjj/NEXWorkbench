import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import type { ShellOpen, AppControl } from '@nex/platform-core';
import type { KnownProject, ResumeItem, ResumeItemKind, ResumePlan, ResumeResult, SavedContext, WorkContext, WorknexSettings } from '../types';
import { isExcludedPath } from '../privacy-engine';
import { localhostPort } from '../activity-engine';

/**
 * Resume engine. Explain first, act second:
 *  - `buildResumePlan` lists what *could* be reopened, with defaults from Settings and reasons for anything unavailable;
 *  - `executeResume` opens only the items the user kept selected, re-derived on the server (a client can't inject paths).
 * It reopens folders, files, URLs and apps — it never restores application memory or state.
 */

type Source = (WorkContext & { kind: 'context' }) | (SavedContext & { kind: 'saved' });
const itemId = (kind: ResumeItemKind, target: string) => `${kind}:${createHash('sha1').update(target).digest('hex').slice(0, 10)}`;

export type PlanDeps = {
  project: KnownProject | null;
  settings: WorknexSettings;
  exists: (path: string) => boolean;
};

/** Internal plan: each item keeps its target server-side. */
export type InternalItem = ResumeItem & { target?: string; app?: { bundleId: string | null; path: string | null } };

export function buildResumePlan(src: Source, deps: PlanDeps): { plan: ResumePlan; internal: InternalItem[] } {
  const { settings, project } = deps;
  const items: InternalItem[] = [];
  const add = (kind: ResumeItemKind, target: string, label: string, detail: string, extra: Partial<InternalItem> = {}) => {
    if (items.some(i => i.id === itemId(kind, target))) return;
    const unavailable = extra.unavailable;
    items.push({ id: itemId(kind, target), kind, label, detail, selected: !unavailable && settings.defaultResume[kind], target, ...extra });
  };
  const projectPath = src.projectPath && !isExcludedPath(src.projectPath, settings.excludedPaths) ? src.projectPath : undefined;
  const title = src.kind === 'saved' ? src.label : src.title;
  const apps = src.applications;

  if (projectPath) {
    const there = deps.exists(projectPath);
    const editor = apps.find(a => a.kind === 'editor' && (a.bundleId || a.path));
    if (editor) add('open-with', projectPath, `Open project in ${editor.name}`, projectPath, { app: { bundleId: editor.bundleId, path: editor.path }, unavailable: there ? undefined : 'Folder not found' });
    add('folder', projectPath, 'Open project folder', projectPath, { unavailable: there ? undefined : 'Folder not found' });
    add('terminal', projectPath, 'Open a terminal in the project', projectPath, { unavailable: there ? undefined : 'Folder not found' });
  }
  if (src.projectId) add('devnex', src.projectId, 'Open DevNEX project', project ? `${project.name} · services, ports, logs` : 'Project details in DevNEX', { route: `/devnex/projects/${src.projectId}` });

  // Local services: live state from DevNEX (only running services can be opened).
  const services = project?.services.filter(s => s.port) ?? (src.kind === 'saved' ? src.services.filter(s => s.port).map(s => ({ ...s, running: false })) : []);
  for (const s of services) {
    const url = `http://localhost:${s.port}`;
    add('service-url', url, `Open ${s.name}`, `localhost:${s.port}`, { unavailable: s.running ? undefined : 'Not running — start it from DevNEX first' });
  }

  for (const f of src.files) {
    if (!f.path || !isAbsolute(f.path) || isExcludedPath(f.path, settings.excludedPaths)) continue;
    add('file', f.path, `Open ${f.name}`, f.path, { unavailable: deps.exists(f.path) ? undefined : 'File not found' });
  }
  for (const u of src.urls) {
    if (localhostPort(u.url) && services.some(s => `http://localhost:${s.port}` === u.url.replace(/\/$/, ''))) continue;
    add('url', u.url, `Open ${u.title ?? u.url}`, u.url);
  }
  // Apps without a better resource (e.g. a document context where only the app is known).
  for (const a of apps) {
    if (a.kind === 'editor' && projectPath) continue;
    if (a.kind === 'meeting' || (!a.bundleId && !a.path)) continue;
    add('app', a.bundleId ?? a.path!, `Launch ${a.name}`, 'Opens the app (not its previous windows)', { app: { bundleId: a.bundleId, path: a.path } });
  }

  const plan: ResumePlan = {
    title, source: src.kind, sourceId: src.id,
    items: items.map(({ target: _t, app: _a, ...i }) => i),
  };
  return { plan, internal: items };
}

/** Open the selected, available items one by one; report each failure with its reason. */
export async function executeResume(internal: InternalItem[], selectedIds: string[], os: ShellOpen & Pick<AppControl, 'launch'>): Promise<ResumeResult> {
  const chosen = internal.filter(i => selectedIds.includes(i.id) && !i.unavailable);
  const result: ResumeResult = { opened: [], failed: [], routes: [] };
  for (const i of chosen) {
    try {
      switch (i.kind) {
        case 'devnex': result.routes.push(i.route!); continue;
        case 'folder': case 'file': await os.openPath(i.target!); break;
        case 'open-with': await os.openWith(i.app!, i.target!); break;
        case 'terminal': await os.openTerminal(i.target!); break;
        case 'service-url': case 'url': await os.openUrl(i.target!); break;
        case 'app': await os.launch({ bundleId: i.app!.bundleId, path: i.app!.path }); break;
      }
      result.opened.push(i.label);
    } catch (e) {
      result.failed.push({ label: i.label, reason: (e as Error).message });
    }
  }
  return result;
}

/** Snapshot a context into a save point. Only references (paths, URLs, app ids) — never content or app state. */
export function toSaved(c: WorkContext, opts: { id: string; label?: string; note?: string; project: KnownProject | null; at?: Date }): SavedContext {
  return {
    id: opts.id, contextId: c.id,
    label: (opts.label?.trim() || c.title).slice(0, 120), note: (opts.note ?? '').trim().slice(0, 1000),
    savedAt: (opts.at ?? new Date()).toISOString(), lastResumedAt: null, type: c.type,
    projectPath: c.projectPath, projectId: c.projectId, gitBranch: c.gitBranch,
    applications: c.applications.map(({ seconds: _s, ...a }) => a),
    files: c.files.map(f => ({ name: f.name, path: f.path, appKey: f.appKey ?? null })),
    urls: c.urls.map(u => ({ url: u.url, title: u.title, appKey: u.appKey ?? null })),
    services: opts.project?.services.map(s => ({ name: s.name, port: s.port })) ?? [],
  };
}

export const describeSaved = (s: SavedContext) => [
  s.applications.length && `${s.applications.length} application${s.applications.length > 1 ? 's' : ''}`,
  s.services.length && `${s.services.length} local service${s.services.length > 1 ? 's' : ''}`,
  s.files.length && `${s.files.length} related file${s.files.length > 1 ? 's' : ''}`,
].filter(Boolean).join(' · ') || basename(s.projectPath ?? s.label);
