import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import type { AppTarget, ForegroundWindow, MemoryReading, PortInfo, Pressure, ProcessInfo } from '@nex/shared';
import type { PlatformAdapter } from '../platform.interface';
import { ActionError, mapKillError } from '../errors';
import { BIG, exec } from '../exec';

const PRESSURE: Record<string, Pressure> = { '1': 'normal', '2': 'warn', '4': 'critical' };

/** Browsers whose active-tab URL can be read via Apple Events (only when the user turns URL tracking on). */
const CHROMIUM = new Set(['com.google.Chrome', 'com.microsoft.edgemac', 'com.brave.Browser', 'company.thebrowser.Browser', 'com.vivaldi.Vivaldi', 'com.operasoftware.Opera']);
const DOC_EXT = /\.(docx?|pptx?|xlsx?|key|pages|numbers|pdf|md|txt|rtf|csv|odt|ods|odp|drawio|fig|sketch|psd|ai)$/i;
/** After the OS refuses window titles (no Accessibility permission), wait this long before asking again. */
const TITLE_BACKOFF_MS = 10 * 60_000;

/** Parse `lsappinfo info` output for the front app. */
export function parseLsappinfo(out: string) {
  return {
    appName: out.match(/^"([^"]+)"/m)?.[1] ?? null,
    bundleId: out.match(/bundleID="([^"]+)"/)?.[1] ?? null,
    path: out.match(/bundle path="([^"]+)"/)?.[1] ?? null,
    pid: Number(out.match(/pid = (\d+)/)?.[1]) || null,
  };
}

export class MacOSAdapter implements PlatformAdapter {
  readonly id = 'darwin' as const;
  private bundleIds = new Map<string, string | null>();
  private titleDeniedUntil = 0;

  async listProcesses(): Promise<ProcessInfo[]> {
    // comm and command can both contain spaces, so each is read as the *last* column of its own ps call.
    const [main, comms] = await Promise.all([
      exec('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,user=,command='], BIG).then(r => r.stdout),
      exec('ps', ['-axo', 'pid=,comm='], BIG).then(r => r.stdout),
    ]);
    const commOf = new Map<number, string>();
    for (const line of comms.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) commOf.set(+m[1], m[2].trim());
    }
    return main.trim().split('\n').flatMap(line => {
      const parts = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!parts) return [];
      const [, pid, ppid, cpu, rss, user, command] = parts;
      const comm = commOf.get(+pid) ?? command;
      const name = comm.split('/').pop() || comm;
      return [{ pid: +pid, ppid: +ppid, name, command: command || comm, cpu: +cpu, memory: +rss * 1024, user }];
    });
  }

  /**
   * Mirrors Activity Monitor: Used = App memory + Wired + Compressed; the rest (file cache, free)
   * is available. os.freemem() alone counts cache as "used" and overstates usage on every Mac.
   */
  async memory(): Promise<MemoryReading> {
    const total = os.totalmem();
    const [vm, swapRaw, level] = await Promise.all([
      exec('vm_stat').then(r => r.stdout),
      exec('sysctl', ['-n', 'vm.swapusage']).then(r => r.stdout).catch(() => ''),
      exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).then(r => r.stdout.trim()).catch(() => ''),
    ]);
    const pageSize = Number(vm.match(/page size of (\d+)/)?.[1] ?? 16384);
    const pages = (label: string) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0) * pageSize;
    const appMemory = Math.max(0, pages('Anonymous pages') - pages('Pages purgeable'));
    const wired = pages('Pages wired down');
    const compressed = pages('Pages occupied by compressor');
    const used = Math.min(total, appMemory + wired + compressed);
    const swapAmount = (label: string) => {
      const m = swapRaw.match(new RegExp(`${label} = ([\\d.]+)([MG])`));
      return m ? Number(m[1]) * (m[2] === 'G' ? 1024 ** 3 : 1024 ** 2) : 0;
    };
    return {
      total, used, available: total - used, compressed,
      cached: pages('File-backed pages'),
      swap: { total: swapAmount('total'), used: swapAmount('used') },
      swapOutBytes: pages('Swapouts'),
      pressure: PRESSURE[level] ?? null,
    };
  }

  async listeningPorts(): Promise<PortInfo[]> {
    // -F: machine-readable fields (p=pid, c=command, n=name). No DNS / port-name lookups (-nP).
    const out = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], BIG).then(r => r.stdout).catch((e: any) => e?.stdout ?? '');
    const seen = new Set<string>();
    const ports: PortInfo[] = [];
    let pid: number | null = null, name: string | null = null;
    for (const line of String(out).split('\n')) {
      const tag = line[0], val = line.slice(1);
      if (tag === 'p') { pid = Number(val) || null; name = null; }
      else if (tag === 'c') name = val;
      else if (tag === 'n') {
        const m = val.match(/^(.*):(\d+)$/);
        if (!m) continue;
        const address = m[1].replace(/^\[|\]$/g, ''), port = Number(m[2]);
        const key = `${pid}:${address}:${port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ports.push({ port, address, pid, processName: name, protocol: 'tcp' });
      }
    }
    return ports.sort((a, b) => a.port - b.port);
  }

  async processCwds(pids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const list = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0))];
    if (!list.length) return map;
    const out = await exec('lsof', ['-a', '-d', 'cwd', '-p', list.join(','), '-Fpn'], BIG).then(r => r.stdout).catch((e: any) => e?.stdout ?? '');
    let pid = 0;
    for (const line of String(out).split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && pid) map.set(pid, line.slice(1));
    }
    return map;
  }

  async bundleId(appPath: string) {
    if (!this.bundleIds.has(appPath)) {
      const id = await exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Contents', 'Info.plist')])
        .then(r => r.stdout.trim()).catch(() => null);
      this.bundleIds.set(appPath, id && /^[A-Za-z0-9.\-_]+$/.test(id) ? id : null);
    }
    return this.bundleIds.get(appPath) ?? null;
  }

  activityKey(app: { bundleId: string | null; path: string | null }) { return app.bundleId; }

  /** Same path as choosing Quit from the app menu: the app can save, ask, or refuse. */
  async quitApp(app: AppTarget) {
    if (!app.bundleId) return this.quitProcess(app.mainPid);
    try {
      // Short timeout: if the app is showing a "Save changes?" sheet the Apple Event waits for the user.
      await exec('osascript', ['-e', `tell application id "${app.bundleId}" to quit`], { timeout: 4000 });
    } catch (e: any) {
      const msg = `${e?.stderr ?? ''} ${e?.message ?? ''}`;
      if (/-1743|not authori[sz]ed|Not authorized/i.test(msg)) {
        throw new ActionError('permission', 'Permission denied. Allow the terminal running NEX to control apps in System Settings › Privacy & Security › Automation, then try again.');
      }
      if (/-600|isn.t running/i.test(msg)) throw new ActionError('gone', 'Process no longer exists. The app already quit.');
      if (e?.killed || e?.signal === 'SIGTERM') return; // timed out waiting on the app — caller re-checks if it closed
      if (/-128|User canceled/i.test(msg)) throw new ActionError('refused', 'Application refused graceful close. You cancelled the quit in the app.');
      throw new ActionError('refused', 'Application refused graceful close.');
    }
  }

  async quitProcess(pid: number) {
    try { process.kill(pid, 'SIGTERM'); } catch (e) { mapKillError(e); }
  }

  async forceKill(pids: number[]) {
    let lastError: unknown = null; let killed = 0;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); killed++; } catch (e: any) { if (e?.code !== 'ESRCH') lastError = e; }
    }
    if (!killed && lastError) mapKillError(lastError);
  }

  async launch(target: { bundleId: string | null; path: string | null }) {
    const args = target.bundleId ? ['-b', target.bundleId] : target.path ? [target.path] : null;
    if (!args) throw new ActionError('unsupported', 'Unsupported operation. Don’t know how to reopen this app.');
    await exec('open', args).catch(() => { throw new ActionError('gone', 'The application could not be found to reopen.'); });
  }

  async activeApp() {
    const [front, idle] = await Promise.all([
      exec('lsappinfo', ['front']).then(r => r.stdout.trim()).then(asn => exec('lsappinfo', ['info', '-only', 'bundleid', '-only', 'pid', asn])).then(r => r.stdout).catch(() => ''),
      exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime']).then(r => r.stdout).catch(() => ''),
    ]);
    const idleNs = Number(idle.match(/"HIDIdleTime" = (\d+)/)?.[1] ?? NaN);
    return {
      key: front.match(/bundleID="([^"]+)"/)?.[1] ?? null,
      pid: Number(front.match(/pid = (\d+)/)?.[1]) || null,
      idleMs: Number.isFinite(idleNs) ? idleNs / 1e6 : null,
    };
  }

  async openPath(path: string) {
    await exec('open', [path]).catch(() => { throw new ActionError('gone', 'The folder could not be opened. It may have been moved.'); });
  }

  /** No permission needed for app/pid/idle. Titles go through System Events and need Accessibility permission. */
  async foregroundWindow(opts: { title: boolean }): Promise<ForegroundWindow> {
    const [front, idle] = await Promise.all([
      exec('lsappinfo', ['front'], { timeout: 2000 }).then(r => r.stdout.trim())
        .then(asn => exec('lsappinfo', ['info', '-only', 'name', '-only', 'bundleid', '-only', 'pid', '-only', 'bundlepath', asn], { timeout: 2000 }))
        .then(r => parseLsappinfo(r.stdout)).catch(() => parseLsappinfo('')),
      exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 2000 }).then(r => r.stdout).catch(() => ''),
    ]);
    const idleNs = Number(idle.match(/"HIDIdleTime" = (\d+)/)?.[1] ?? NaN);
    let title: string | null = null;
    let titleStatus: ForegroundWindow['titleStatus'] = 'off';
    if (opts.title && front.pid) {
      if (Date.now() < this.titleDeniedUntil) titleStatus = 'needs-permission';
      else {
        try {
          // Unix pid of the front process: never relies on app names that could be spoofed.
          const r = await exec('osascript', ['-e', `tell application "System Events" to tell (first process whose unix id is ${front.pid}) to get name of front window`], { timeout: 2500 });
          title = r.stdout.trim() || null;
          titleStatus = 'ok';
        } catch (e: any) {
          const msg = `${e?.stderr ?? ''} ${e?.message ?? ''}`;
          if (/-1719|-25211|assistive|not allowed/i.test(msg) || e?.killed) { this.titleDeniedUntil = Date.now() + TITLE_BACKOFF_MS; titleStatus = 'needs-permission'; }
          else if (/-1728|-1700|Invalid index|Can.t get/i.test(msg)) titleStatus = 'ok'; // the app simply has no window
          else titleStatus = 'unavailable';
        }
      }
    }
    return { ...front, key: front.bundleId, title, titleStatus, idleMs: Number.isFinite(idleNs) ? idleNs / 1e6 : null };
  }

  async browserUrl(app: { bundleId: string | null; path: string | null }) {
    const id = app.bundleId;
    if (!id || !/^[A-Za-z0-9.\-_]+$/.test(id)) return null;
    const script = CHROMIUM.has(id) ? `tell application id "${id}" to get URL of active tab of front window`
      : id === 'com.apple.Safari' ? `tell application id "${id}" to get URL of front document` : null;
    if (!script) return null;
    try {
      const url = (await exec('osascript', ['-e', script], { timeout: 2000 })).stdout.trim();
      return /^https?:\/\//i.test(url) ? url : null;
    } catch { return null; }
  }

  /** ps %CPU is already a short moving average (~1 min decay), which suits "is a call running" well. */
  async appCpuPercent(pids: number[]) {
    const list = pids.filter(p => Number.isInteger(p) && p > 0).slice(0, 200);
    if (!list.length) return 0;
    const out = await exec('ps', ['-o', 'pcpu=', '-p', list.join(',')], { timeout: 3000 }).then(r => r.stdout).catch((e: any) => String(e?.stdout ?? ''));
    return out.split('\n').reduce((n, l) => n + (Number(l.trim()) || 0), 0);
  }

  async installedApplications() {
    const roots = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(os.homedir(), 'Applications')];
    const paths = roots.flatMap(r => { try { return readdirSync(r).filter(f => f.endsWith('.app')).map(f => join(r, f)); } catch { return []; } }).slice(0, 400);
    const out: { name: string; path: string; bundleId: string | null }[] = [];
    // Bundle ids are read a few at a time (plutil per app); results are cached by the caller.
    for (let i = 0; i < paths.length; i += 16) {
      const batch = await Promise.all(paths.slice(i, i + 16).map(async p => ({ name: p.split('/').pop()!.replace(/\.app$/, ''), path: p, bundleId: await this.bundleId(p) })));
      out.push(...batch);
    }
    return out;
  }

  /** Document files the app holds open, from lsof (names only). Limited to the user's home, skipping app internals. */
  async openDocuments(pid: number) {
    if (!Number.isInteger(pid) || pid < 2) return [];
    const out = await exec('lsof', ['-p', String(pid), '-Fn'], { timeout: 3000, ...BIG }).then(r => r.stdout).catch((e: any) => String(e?.stdout ?? ''));
    const home = os.homedir();
    const seen = new Set<string>();
    for (const line of out.split('\n')) {
      if (line[0] !== 'n') continue;
      const f = line.slice(1);
      if (!f.startsWith(home + '/') || !DOC_EXT.test(f) || /\/(Library|\.[^/]+)\//.test(f.slice(home.length)) || /\/~\$/.test(f)) continue;
      seen.add(f);
      if (seen.size >= 10) break;
    }
    return [...seen];
  }

  async openUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) throw new ActionError('unsupported', 'Only web addresses (http/https) can be opened.');
    await exec('open', [url]).catch(() => { throw new ActionError('unsupported', 'The browser could not be opened.'); });
  }

  async openWith(app: { bundleId: string | null; path: string | null }, target: string) {
    const args = app.bundleId ? ['-b', app.bundleId, target] : app.path ? ['-a', app.path, target] : null;
    if (!args) throw new ActionError('unsupported', 'Unsupported operation. Don’t know which application to use.');
    await exec('open', args).catch(() => { throw new ActionError('gone', 'The application or the item could not be found.'); });
  }

  async revealPath(path: string) {
    if (!existsSync(path)) throw new ActionError('gone', 'The file could not be found. It may have been moved or deleted.');
    await exec('open', ['-R', path]).catch(() => { throw new ActionError('unsupported', 'Finder could not show the file.'); });
  }

  async openTerminal(dir: string) {
    if (!existsSync(dir)) throw new ActionError('gone', 'The folder could not be found. It may have been moved.');
    await exec('open', ['-a', 'Terminal', dir]).catch(() => { throw new ActionError('unsupported', 'Terminal could not be opened.'); });
  }

  spawnService(command: string, cwd: string, env: Record<string, string> = {}) {
    // detached → the child leads a new process group, so the whole tree (npm → node → workers) can be signalled.
    return spawn(command, { cwd, shell: '/bin/sh', detached: true, env: { ...process.env, FORCE_COLOR: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async stopTree(pid: number) {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch (e) { mapKillError(e); } }
  }

  async killTree(pid: number) {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch (e) { mapKillError(e); } }
  }

  /** Outermost .app bundle, so helpers inside "Google Chrome.app/…/Helper.app" resolve to Chrome. */
  appPathOf(command: string) { return command.match(/^(.*?\.app)(?=\/|$)/)?.[1] ?? null; }

  /** Info.plist → CFBundleIconFile (.icns) → PNG via sips. Falls back to AppIcon.icns or the only .icns. */
  async extractIcon(appPath: string, outFile: string, size: number) {
    const resources = join(appPath, 'Contents', 'Resources');
    if (!existsSync(resources)) return false;
    let name = '';
    try { name = (await exec('plutil', ['-extract', 'CFBundleIconFile', 'raw', join(appPath, 'Contents', 'Info.plist')])).stdout.trim(); } catch {}
    const icns = readdirSync(resources).filter(f => f.endsWith('.icns'));
    const pick = [name, `${name}.icns`, 'AppIcon.icns'].find(n => n && icns.includes(n)) ?? (icns.length === 1 ? icns[0] : undefined);
    if (!pick) return false;
    await exec('sips', ['-s', 'format', 'png', '-Z', String(size), join(resources, pick), '--out', outFile], { timeout: 8000 });
    return existsSync(outFile);
  }
}
