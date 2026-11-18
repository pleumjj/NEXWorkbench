import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import type { AppTarget, ForegroundWindow, MemoryReading, PortInfo, ProcessInfo } from '@nex/shared';
import type { PlatformAdapter } from '../platform.interface';
import { ActionError, mapKillError } from '../errors';
import { BIG, exec } from '../exec';

const ps = (command: string, timeout = 8000) =>
  exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout, ...BIG }).then(r => r.stdout);
/** PowerShell single-quoted literal ('' escapes '). */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const asArray = (data: any) => (Array.isArray(data) ? data : data ? [data] : []);

/** Windows implementation. NOTE: not yet verified on a real Windows machine. */
export class WindowsAdapter implements PlatformAdapter {
  readonly id = 'win32' as const;

  async listProcesses(): Promise<ProcessInfo[]> {
    // Parent pids come from Win32_Process (Get-Process has no parent on Windows PowerShell 5).
    const stdout = await ps("$par=@{}; $st=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { $par[[int]$_.ProcessId]=[int]$_.ParentProcessId; if ($_.CreationDate) { $st[[int]$_.ProcessId]=[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } }; Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path,@{n='Parent';e={$par[[int]$_.Id]}},@{n='Started';e={$st[[int]$_.Id]}} | ConvertTo-Json -Compress");
    return asArray(JSON.parse(stdout || '[]')).map((p: any) => ({
      pid: p.Id, ppid: Number(p.Parent) || undefined, name: p.ProcessName, command: p.Path || p.ProcessName,
      cpu: Number(p.CPU || 0), memory: Number(p.WorkingSet64 || 0), user: '—', startedAt: Number(p.Started) || undefined,
    }));
  }

  /**
   * On Windows os.freemem() already returns *available* memory (free + standby), so it is the right base.
   * Page-file growth stands in for the pressure signal macOS reports directly.
   */
  async memory(): Promise<MemoryReading> {
    const total = os.totalmem(), available = os.freemem();
    let swap = { total: 0, used: 0 }, cached = 0, swapOutBytes: number | null = null;
    try {
      const raw = JSON.parse(await ps(
        "$m=Get-CimInstance Win32_PerfRawData_PerfOS_Memory; $p=Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize,CurrentUsage -Sum; " +
        "[pscustomobject]@{cache=$m.CacheBytes; pagesOut=$m.PagesOutputPersec; alloc=($p | ? Property -eq 'AllocatedBaseSize').Sum; used=($p | ? Property -eq 'CurrentUsage').Sum} | ConvertTo-Json -Compress"));
      swap = { total: Number(raw.alloc || 0) * 1024 ** 2, used: Number(raw.used || 0) * 1024 ** 2 };
      cached = Number(raw.cache || 0);
      swapOutBytes = raw.pagesOut != null ? Number(raw.pagesOut) * 4096 : null; // cumulative counter (raw class)
    } catch { /* keep defaults — health falls back to available memory */ }
    return { total, used: total - available, available, compressed: 0, cached, swap, swapOutBytes, pressure: null };
  }

  async listeningPorts(): Promise<PortInfo[]> {
    try {
      const out = await ps("Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{a=$_.LocalAddress; p=$_.LocalPort; o=$_.OwningProcess; n=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName} } | ConvertTo-Json -Compress");
      const seen = new Set<string>();
      return asArray(JSON.parse(out || '[]')).flatMap((r: any) => {
        const key = `${r.o}:${r.a}:${r.p}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ port: Number(r.p), address: String(r.a), pid: Number(r.o) || null, processName: r.n ?? null, protocol: 'tcp' as const }];
      }).sort((a, b) => a.port - b.port);
    } catch { return []; }
  }

  /** Windows does not expose another process's working directory without native code. */
  async processCwds(): Promise<Map<number, string>> { return new Map(); }

  async bundleId() { return null; }
  activityKey(app: { bundleId: string | null; path: string | null }) { return app.path ? app.path.toLowerCase() : null; }

  /** CloseMainWindow is the same message as clicking the window's X — apps can prompt to save. */
  async quitApp(app: AppTarget) {
    const ids = app.pids.filter(Number.isInteger).join(',');
    if (!ids) throw new ActionError('gone', 'Process no longer exists.');
    const out = await ps(`$r=$false; Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { if ($_.MainWindowHandle -ne 0) { $r = $_.CloseMainWindow() -or $r } }; $r`)
      .catch(e => mapKillError(e));
    if (!/True/i.test(out)) throw new ActionError('unsupported', 'Unsupported operation. This app has no window to close; use Force close if you are sure.');
  }

  async quitProcess(pid: number) {
    await exec('taskkill.exe', ['/PID', String(pid)]).catch(e => mapKillError(e));
  }

  async forceKill(pids: number[]) {
    const args = pids.flatMap(p => ['/PID', String(p)]);
    await exec('taskkill.exe', [...args, '/T', '/F']).catch(e => { if (!/not found/i.test(String(e?.stderr))) mapKillError(e); });
  }

  async launch(target: { bundleId: string | null; path: string | null }) {
    if (!target.path) throw new ActionError('unsupported', 'Unsupported operation. Don’t know how to reopen this app.');
    await ps(`Start-Process -FilePath ${lit(target.path)}`).catch(() => { throw new ActionError('gone', 'The application could not be found to reopen.'); });
  }

  async activeApp() {
    try {
      const out = await ps(
        "Add-Type -Namespace NEX -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p); [StructLayout(LayoutKind.Sequential)] public struct L { public uint s; public uint t; } [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref L l);' -UsingNamespace System.Runtime.InteropServices; " +
        "$p=0; [void][NEX.U]::GetWindowThreadProcessId([NEX.U]::GetForegroundWindow(), [ref]$p); $l=New-Object NEX.U+L; $l.s=8; [void][NEX.U]::GetLastInputInfo([ref]$l); " +
        "[pscustomobject]@{pid=$p; path=(Get-Process -Id $p -ErrorAction SilentlyContinue).Path; idle=([Environment]::TickCount - $l.t)} | ConvertTo-Json -Compress", 5000);
      const r = JSON.parse(out);
      return { key: r.path ? String(r.path).toLowerCase() : null, pid: Number(r.pid) || null, idleMs: Number.isFinite(r.idle) ? Number(r.idle) : null };
    } catch { return { key: null, pid: null, idleMs: null }; }
  }

  async openPath(path: string) {
    if (!existsSync(path)) throw new ActionError('gone', 'The folder could not be opened. It may have been moved.');
    // explorer.exe exits with code 1 even when it succeeds, so its exit status is ignored.
    await exec('explorer.exe', [path]).catch(() => undefined);
  }

  /** GetForegroundWindow + GetWindowText (no special permission on Windows). Title only when asked. */
  async foregroundWindow(opts: { title: boolean }): Promise<ForegroundWindow> {
    const none: ForegroundWindow = { appName: null, key: null, bundleId: null, path: null, pid: null, title: null, titleStatus: opts.title ? 'unavailable' : 'off', idleMs: null };
    try {
      const out = await ps(
        "Add-Type -Namespace NEX -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n); [StructLayout(LayoutKind.Sequential)] public struct L { public uint s; public uint t; } [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref L l);' -UsingNamespace System.Runtime.InteropServices; " +
        "$h=[NEX.W]::GetForegroundWindow(); $p=0; [void][NEX.W]::GetWindowThreadProcessId($h, [ref]$p); " +
        (opts.title ? "$sb=New-Object System.Text.StringBuilder 512; [void][NEX.W]::GetWindowText($h, $sb, 512); $t=$sb.ToString(); " : "$t=$null; ") +
        "$l=New-Object NEX.W+L; $l.s=8; [void][NEX.W]::GetLastInputInfo([ref]$l); $pr=Get-Process -Id $p -ErrorAction SilentlyContinue; " +
        "[pscustomobject]@{pid=$p; path=$pr.Path; name=$(if ($pr.Description) { $pr.Description } else { $pr.ProcessName }); title=$t; idle=([Environment]::TickCount - $l.t)} | ConvertTo-Json -Compress", 5000);
      const r = JSON.parse(out);
      const path = r.path ? String(r.path) : null;
      return {
        appName: r.name ? String(r.name) : null, key: path ? path.toLowerCase() : null, bundleId: null, path, pid: Number(r.pid) || null,
        title: opts.title && r.title ? String(r.title) : null, titleStatus: opts.title ? 'ok' : 'off', idleMs: Number.isFinite(r.idle) ? Number(r.idle) : null,
      };
    } catch { return none; }
  }

  /** Reading a browser's URL needs browser-specific UI automation on Windows — not supported in v1. */
  async browserUrl() { return null; }
  /** Get-Process CPU is cumulative seconds: sample twice, one second apart, to get a percentage. */
  async appCpuPercent(pids: number[]) {
    const ids = pids.filter(p => Number.isInteger(p) && p > 0).slice(0, 200).join(',');
    if (!ids) return 0;
    try {
      const out = await ps(`$a=(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum; Start-Sleep -Milliseconds 1000; $b=(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum; [math]::Max(0, ($b - $a) * 100)`, 6000);
      return Number(out.trim()) || 0;
    } catch { return 0; }
  }

  /** v1 lists running apps only on Windows (installed-app enumeration needs registry/Start-menu parsing). */
  async installedApplications() { return [] as { name: string; path: string; bundleId: string | null }[]; }
  /** Windows does not expose another process's open files without native code. */
  async openDocuments() { return [] as string[]; }

  async openUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) throw new ActionError('unsupported', 'Only web addresses (http/https) can be opened.');
    await ps(`Start-Process ${lit(url)}`).catch(() => { throw new ActionError('unsupported', 'The browser could not be opened.'); });
  }

  async openWith(app: { bundleId: string | null; path: string | null }, target: string) {
    if (!app.path) throw new ActionError('unsupported', 'Unsupported operation. Don’t know which application to use.');
    await ps(`Start-Process -FilePath ${lit(app.path)} -ArgumentList ${lit(`"${target}"`)}`).catch(() => { throw new ActionError('gone', 'The application or the item could not be found.'); });
  }

  async revealPath(path: string) {
    if (!existsSync(path)) throw new ActionError('gone', 'The file could not be found. It may have been moved or deleted.');
    // explorer.exe exits with code 1 even on success.
    await exec('explorer.exe', [`/select,${path}`]).catch(() => undefined);
  }

  /** Recycle Bin via Microsoft.VisualBasic (the path is passed in an environment variable, never interpolated). */
  async trashPath(path: string) {
    if (!existsSync(path)) throw new ActionError('gone', 'It is no longer there.');
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:NEX_TRASH_PATH; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 300_000, env: { ...process.env, NEX_TRASH_PATH: path } })
      .catch(e => { throw new ActionError('unsupported', `Could not move it to the Recycle Bin (${String(e?.stderr || e?.message || e).trim().slice(0, 120)}).`); });
  }

  async openTerminal(dir: string) {
    if (!existsSync(dir)) throw new ActionError('gone', 'The folder could not be found. It may have been moved.');
    // Windows Terminal when installed, otherwise a classic console in that folder.
    await exec('wt.exe', ['-d', dir]).catch(() => ps(`Start-Process cmd.exe -WorkingDirectory ${lit(dir)}`))
      .catch(() => { throw new ActionError('unsupported', 'A terminal could not be opened.'); });
  }

  spawnService(command: string, cwd: string, env: Record<string, string> = {}) {
    return spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async stopTree(pid: number) {
    await exec('taskkill.exe', ['/PID', String(pid), '/T']).catch(e => mapKillError(e));
  }

  async killTree(pid: number) {
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(e => { if (!/not found/i.test(String(e?.stderr))) mapKillError(e); });
  }

  appPathOf(command: string) { return /\.exe$/i.test(command.trim()) ? command.trim() : null; }

  async extractIcon(appPath: string, outFile: string) {
    try {
      await ps(`Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Icon]::ExtractAssociatedIcon(${lit(appPath)}); $i.ToBitmap().Save(${lit(outFile)},[System.Drawing.Imaging.ImageFormat]::Png)`);
      return existsSync(outFile);
    } catch { return false; }
  }
}
