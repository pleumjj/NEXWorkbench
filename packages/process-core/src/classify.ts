import type { ProcessInfo } from '@nex/shared';
import { agentName, detectAgent } from './agents';

/** How a process is treated: a GUI app, a command-line tool, the OS, or NEX Workbench itself. */
export type GroupKind = 'app' | 'cli' | 'system' | 'self';
export type GroupIdentity = { id: string; name: string; kind: GroupKind; path: string | null };

export type ClassifyOptions = {
  /** Workspace root of NEX Workbench: processes running from here are "self" and never controllable. */
  selfRoot: string;
  selfPid: number;
  selfName?: string;
  /** Display name for the OS group, e.g. "macOS system services". */
  systemName: string;
};

/** Paths that belong to the operating system. Anything here is System Critical — in the API, not only the UI. */
const SYSTEM_PATH = /^(\/System\/|\/usr\/(libexec|sbin)\/|\/sbin\/|\/Library\/Apple\/|\/usr\/lib\/|[a-z]:\\windows\\)/i;
/** Apple's bundled user apps (TextEdit, Calculator, Safari…) live under /System but are ordinary apps. */
const APPLE_USER_APP = /^\/System\/(Volumes\/Preboot\/Cryptexes\/App\/System\/)?Applications\//;
const SYSTEM_NAMES = new Set([
  // macOS
  'kernel_task', 'launchd', 'windowserver', 'loginwindow', 'dock', 'finder', 'systemuiserver', 'controlcenter', 'coreaudiod', 'mds', 'mds_stores',
  // Windows
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'explorer', 'dwm', 'fontdrvhost', 'spoolsv', 'memory compression', 'secure system',
]);
/** Accounts that only run OS services (macOS uses _underscore service accounts). */
const SYSTEM_USER = /^(root|_.+|SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i;

/** Executable part of a command line (drops arguments). */
export const executableOf = (command: string) => command.split(/\s+-{1,2}[A-Za-z]/)[0];

/** Command-line tools rewrite their title ("npm run dev", "postgres: db", "-zsh"): keep the tool name. */
export const toolName = (name: string) => name.replace(/^-/, '').split(/\s+/)[0].replace(/[:(].*$/, '').replace(/@.*$/, '') || name;

export function classifyProcess(p: ProcessInfo, opts: ClassifyOptions): GroupIdentity {
  const exe = executableOf(p.command);
  if (p.pid === opts.selfPid || (opts.selfRoot && p.command.includes(opts.selfRoot))) {
    return { id: 'self', name: opts.selfName ?? 'NEX Workbench', kind: 'self', path: null };
  }
  const system = { id: 'system', name: opts.systemName, kind: 'system' as const, path: null };
  if ((!APPLE_USER_APP.test(exe) && SYSTEM_PATH.test(exe)) || SYSTEM_NAMES.has(p.name.toLowerCase().replace(/\.exe$/i, '')) || p.pid <= 1) return system;
  // AI coding agents (Claude Code, Codex…) are one group each, wherever they are installed (CLI, editor extension, app).
  const agent = detectAgent(p);
  if (agent) return { id: `agent:${agent}`, name: agentName(agent), kind: 'cli', path: null };
  // Outermost bundle: helpers inside "Google Chrome.app/…/Helper.app" belong to Chrome.
  const bundle = exe.match(/^(.*?\.app)(?=\/|$)/)?.[1];
  if (bundle) {
    const name = bundle.split('/').pop()!.replace(/\.app$/, '').replace(/\s+\d+$/, '');
    return { id: `app:${bundle}`, name, kind: 'app', path: bundle };
  }
  if (/\.vscode\/extensions\//.test(exe)) return { id: 'cli:vscode-extensions', name: 'VS Code extensions', kind: 'cli', path: null };
  if (SYSTEM_USER.test(p.user)) return system;
  if (/\.exe$/i.test(exe)) {
    const name = exe.split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
    return { id: `app:${exe.toLowerCase()}`, name, kind: 'app', path: exe };
  }
  const base = toolName(p.name);
  return { id: `cli:${base.toLowerCase()}`, name: base, kind: 'cli', path: null };
}
