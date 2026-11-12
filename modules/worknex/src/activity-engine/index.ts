import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ForegroundWindow } from '@nex/shared';
import type { ActivityEvent, AppKind, KnownProject } from '../types';

/**
 * Activity engine: turns one sanitized front-window reading into a normalized ActivityEvent.
 * Pure functions — the engine decides when to sample; this file only interprets metadata.
 */

const KIND_RULES: [AppKind, RegExp][] = [
  ['meeting', /\b(zoom|zoom\.us|microsoft teams|teams|webex|facetime|skype|whereby|around)\b/i],
  ['editor', /\b(visual studio code|vscode|code|cursor|windsurf|zed|sublime text|intellij|webstorm|pycharm|goland|rider|phpstorm|rubymine|clion|android studio|xcode|nova|bbedit|macvim|neovide|fleet)\b/i],
  ['terminal', /\b(terminal|iterm2?|warp|ghostty|alacritty|kitty|hyper|wezterm|windowsterminal|windows terminal|powershell|cmd|tabby)\b/i],
  ['browser', /\b(google chrome|chrome|safari|firefox|microsoft edge|msedge|edge|brave browser|brave|arc|vivaldi|opera|chromium|orion)\b/i],
  ['document', /\b(microsoft word|word|winword|microsoft excel|excel|microsoft powerpoint|powerpoint|powerpnt|keynote|pages|numbers|preview|acrobat|adobe acrobat|libreoffice|soffice|onenote|notion|obsidian|figma|sketch|drawio|draw\.io|textedit|notepad)\b/i],
];

/** Classify an application from its display name, bundle id or executable. */
export function appKindOf(fw: Pick<ForegroundWindow, 'appName' | 'bundleId' | 'path'>): AppKind {
  const hay = [fw.appName, fw.bundleId?.split('.').slice(-1)[0], fw.path?.split(/[\\/]/).pop()?.replace(/\.(app|exe)$/i, '')].filter(Boolean).join(' ');
  for (const [kind, re] of KIND_RULES) if (re.test(hay)) return kind;
  return 'other';
}

const SEPARATORS = /\s+[—–\-|]\s+/;
const FILE_LIKE = /^[^\\/:*?"<>|]{1,120}\.[A-Za-z0-9]{1,6}$/;
const DOCUMENT_EXT = /\.(docx?|pptx?|xlsx?|key|pages|numbers|pdf|md|txt|rtf|csv|odt|ods|odp|drawio|fig|sketch)$/i;
const BROWSER_SUFFIX = /\s+[—–\-]\s+(google chrome|chromium|safari|mozilla firefox|firefox|microsoft​? ?edge|brave|arc|vivaldi|opera)(\s+[—–\-].*)?$/i;
const APP_SUFFIX = /\s+[—–\-]\s+(microsoft )?(word|excel|powerpoint|keynote|pages|numbers|preview|adobe acrobat( reader)?|libreoffice.*|visual studio code|cursor)$/i;

/** Split a window title into meaningful parts: "● engine.ts — NEXWorkbench" → ["engine.ts", "NEXWorkbench"]. */
export function titleParts(title: string): string[] {
  return title.replace(BROWSER_SUFFIX, '').replace(APP_SUFFIX, '').replace(/^[●•*]\s*/, '')
    .split(SEPARATORS).map(s => s.replace(/\s*\((edited|saved|read-only|compatibility mode)\)\s*$/i, '').replace(/\s+[—–-]\s+(edited|saved)$/i, '').trim()).filter(Boolean);
}

/** File name a window title refers to, if any ("ISO29110_Executive_v6.pptx", "version.service.ts"). */
export function fileFromTitle(title: string, kind: AppKind): string | null {
  const parts = titleParts(title);
  const file = parts.find(p => FILE_LIKE.test(p) && !/^\d+(\.\d+)+$/.test(p) && !/^[a-z0-9-]+\.(com|org|net|io|dev|co|th|app)$/i.test(p));
  if (file) return file;
  // Office/Keynote titles often omit the extension: the whole title is the document name.
  if (kind === 'document' && parts[0] && parts[0].length <= 120 && !/^(untitled|document\d*|book\d*|presentation\d*)$/i.test(parts[0])) return parts[0];
  return null;
}

export const isMeetingTitle = (title: string) => /(^|\s)(google meet|meet\s+[—–-]\s|zoom meeting|microsoft teams meeting|webex meeting)/i.test(title) || /^Meet\s+[—–-]/i.test(title);

export function localhostPort(url: string | null | undefined): number | null {
  const m = String(url ?? '').match(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})(?:[/?#]|$)/i);
  return m ? Number(m[1]) : null;
}

const within = (child: string, parent: string) => {
  const c = child.replace(/\\/g, '/').replace(/\/+$/, ''), p = parent.replace(/\\/g, '/').replace(/\/+$/, '');
  return c === p || c.startsWith(`${p}/`);
};

/**
 * Tie an observation to a DevNEX project, conservatively. Evidence, strongest first:
 *  1. a window-title segment equal to the project's name or folder name (disambiguates multi-window editors),
 *  2. a file path / working directory of the app's own child processes inside exactly one project,
 *  3. a localhost URL whose port belongs to a running service of exactly one project.
 * Ambiguous evidence → no project (two contexts are better than one wrong one).
 */
export function associateProject(projects: KnownProject[], ev: { title?: string | null; dirs?: string[]; filePath?: string | null; url?: string | null }): { project: KnownProject; signal: string } | null {
  const unique = (list: KnownProject[]) => { const ids = new Set(list.map(p => p.id)); return ids.size === 1 ? list[0] : null; };
  if (ev.title) {
    const parts = titleParts(ev.title).map(s => s.toLowerCase());
    const hits = projects.filter(p => [p.name, basename(p.path)].map(s => s.toLowerCase()).some(n => n.length >= 3 && parts.includes(n)));
    const hit = unique(hits);
    if (hit) return { project: hit, signal: 'window-title' };
  }
  const paths = [ev.filePath, ...(ev.dirs ?? [])].filter((x): x is string => !!x);
  if (paths.length) {
    // Longest project path wins for each path (a workspace package inside a monorepo).
    const hits = paths.map(d => [...projects].sort((a, b) => b.path.length - a.path.length).find(p => within(d, p.path))).filter((p): p is KnownProject => !!p);
    const hit = unique(hits);
    if (hit) return { project: hit, signal: ev.filePath && within(ev.filePath, hit.path) ? 'file-path' : 'process-cwd' };
  }
  const port = localhostPort(ev.url);
  if (port) {
    const hit = unique(projects.filter(p => p.services.some(s => s.running && s.port === port)));
    if (hit) return { project: hit, signal: 'localhost-port' };
  }
  return null;
}

const id = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Build the normalized event. Inputs are already sanitized by the privacy engine. */
export function normalizeActivity(
  fw: ForegroundWindow,
  ctx: { at: Date; projects: KnownProject[]; dirs?: string[]; openDocs?: string[]; url?: string | null; trackFiles: boolean; kind?: AppKind },
): ActivityEvent {
  const kind0 = ctx.kind ?? appKindOf(fw);
  const title = fw.title ?? undefined;
  const kind: AppKind = kind0 === 'browser' && title && isMeetingTitle(title) ? 'meeting' : kind0;
  const signals: string[] = ['foreground-app'];
  let fileName: string | undefined, filePath: string | undefined;
  if (ctx.trackFiles) {
    const doc = ctx.openDocs?.[0];
    if (doc) { filePath = doc; fileName = basename(doc); signals.push('open-document'); }
    else if (title && kind !== 'browser' && kind !== 'meeting') {
      const f = fileFromTitle(title, kind);
      if (f) { fileName = f; signals.push('window-title-file'); }
    }
  }
  if (title) signals.push('window-title');
  const assoc = kind === 'meeting' ? null : associateProject(ctx.projects, { title, dirs: ctx.dirs, filePath, url: ctx.url });
  if (assoc) signals.push(assoc.signal);
  return {
    id: id(`${ctx.at.toISOString()}:${fw.pid}:${title ?? ''}`),
    timestamp: ctx.at.toISOString(),
    app: fw.appName ?? basename(fw.path ?? fw.key ?? 'Unknown app').replace(/\.(app|exe)$/i, ''),
    appKey: fw.key,
    appKind: kind,
    processId: fw.pid ?? undefined,
    windowTitle: title,
    fileName, filePath,
    projectId: assoc?.project.id, projectPath: assoc?.project.path, projectName: assoc?.project.name,
    url: ctx.url ?? undefined,
    signals,
    source: 'foreground',
  };
}

export const isDocumentFile = (name: string) => DOCUMENT_EXT.test(name);
