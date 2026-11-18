import type { ChildProcess } from 'node:child_process';
import type { AppTarget, ForegroundInfo, ForegroundWindow, MemoryReading, PortInfo, ProcessInfo } from '@nex/shared';

/**
 * OS capabilities, split into small interfaces so consumers depend only on what they use.
 * All OS-specific behaviour lives behind these — never `process.platform` checks in apps or modules.
 */
export interface ProcessSource {
  listProcesses(): Promise<ProcessInfo[]>;
}
export interface MemorySource {
  memory(): Promise<MemoryReading>;
}
export interface PortSource {
  /** Listening TCP sockets mapped to their owning process. */
  listeningPorts(): Promise<PortInfo[]>;
  /** Working directory per pid, where the OS exposes it (empty map otherwise). */
  processCwds(pids: number[]): Promise<Map<number, string>>;
}
export interface AppControl {
  /** Bundle identifier (macOS) for an application path, if any. */
  bundleId(appPath: string): Promise<string | null>;
  /** Ask the whole application to quit the way the OS does it (menu → Quit). Never forces. */
  quitApp(app: AppTarget): Promise<void>;
  /** Ask a single non-GUI process to terminate (SIGTERM / taskkill without /F). */
  quitProcess(pid: number): Promise<void>;
  /** Immediately end the given processes. Only call after explicit user confirmation. */
  forceKill(pids: number[]): Promise<void>;
  /** Re-launch an application by bundle id / path. */
  launch(target: { bundleId: string | null; path: string | null }): Promise<void>;
}
export interface ActivitySource {
  /** Which app is in front right now and how long since the user last touched input. No permissions needed. */
  activeApp(): Promise<ForegroundInfo>;
}
export interface IconSource {
  /** Application path/bundle that owns a command line, used as icon + identity source. */
  appPathOf(command: string): string | null;
  /** Write the app's icon as PNG to `outFile`. Returns false if the app has no icon. */
  extractIcon(appPath: string, outFile: string, size: number): Promise<boolean>;
}

/** Run and stop developer services (a command line + its whole process tree). */
export interface ServiceControl {
  /** Start a project-defined command in `cwd`. Output is piped; the child leads its own process group where supported. */
  spawnService(command: string, cwd: string, env?: Record<string, string>): ChildProcess;
  /** Graceful stop of a process and its children (SIGTERM to the group / taskkill /T without /F). */
  stopTree(pid: number): Promise<void>;
  /** Forced stop of a process tree. Only after explicit user confirmation. */
  killTree(pid: number): Promise<void>;
}

/** Open things the way the OS does (Finder/Explorer, default browser, default app). Never runs arbitrary commands. */
export interface ShellOpen {
  /** Reveal a folder, or open a file with its default app. */
  openPath(path: string): Promise<void>;
  /** Open an http(s) URL in the default browser. */
  openUrl(url: string): Promise<void>;
  /** Open a file or folder with a specific installed application (e.g. a folder in the editor that was used). */
  openWith(app: { bundleId: string | null; path: string | null }, target: string): Promise<void>;
  /** Open a terminal window in a directory. */
  openTerminal(dir: string): Promise<void>;
  /** Show a file selected in Finder / Explorer. */
  revealPath(path: string): Promise<void>;
}

/** Move a file or folder to the OS Trash / Recycle Bin (recoverable there). Only after explicit user confirmation. */
export interface FileTrash {
  trashPath(path: string): Promise<void>;
}

/**
 * Window-level metadata for work continuity (WorkNEX). Metadata only: no content, keystrokes, clipboard or screenshots.
 */
export interface WindowSource {
  /** Front app + (optionally) its window title + idle time. Titles may need OS permission (macOS Accessibility). */
  foregroundWindow(opts: { title: boolean }): Promise<ForegroundWindow>;
  /** Active tab URL of a supported browser, or null. Only called when the user enabled URL tracking. */
  browserUrl(app: { bundleId: string | null; path: string | null }): Promise<string | null>;
  /** Current CPU use of these processes, in % of one core (summed). Used to tell an active call from an idle meeting app. */
  appCpuPercent(pids: number[]): Promise<number>;
  /** Installed GUI applications where the OS lists them (macOS: Applications folders). Used only to let the user choose apps. */
  installedApplications(): Promise<{ name: string; path: string; bundleId: string | null }[]>;
  /** Document files the process currently holds open (names/paths from the OS, never contents). Empty where unsupported. */
  openDocuments(pid: number): Promise<string[]>;
}

export interface PlatformAdapter extends ProcessSource, MemorySource, PortSource, AppControl, ActivitySource, IconSource, ServiceControl, ShellOpen, FileTrash, WindowSource {
  readonly id: 'darwin' | 'win32';
  /** Activity key matching ForegroundInfo.key: bundle id on macOS, lower-cased exe path on Windows. */
  activityKey(app: { bundleId: string | null; path: string | null }): string | null;
}
