/** DevNEX domain model. Everything is derived from local inspection — no cloud, no AI. */

export type ServiceStatus = 'STOPPED' | 'STARTING' | 'RUNNING' | 'WARNING' | 'FAILED' | 'UNKNOWN';
export type ServiceType = 'frontend' | 'backend' | 'database' | 'cache' | 'worker' | 'queue' | 'container' | 'app';

/** devnex.config.json */
export type DevnexConfig = {
  name?: string;
  services?: { name: string; command?: string; port?: number; type?: ServiceType; healthUrl?: string }[];
};

export type ServiceDefinition = {
  id: string;
  name: string;
  type: ServiceType;
  /** Command DevNEX would run — only ever taken from the project's own files, never from an API request. */
  command: string | null;
  port: number | null;
  source: 'devnex.config.json' | 'package.json' | 'docker-compose';
};

export type Service = ServiceDefinition & {
  projectId: string;
  status: ServiceStatus;
  /** Who runs it: started by DevNEX (logs available), found running on its own, or not running. */
  managedBy: 'devnex' | 'external' | null;
  /** DevNEX has a log buffer for it (it started the service this session, even if it has since stopped). */
  hasLogs: boolean;
  pid: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  startedAt: string | null;
  exitCode: number | null;
  health: 'ok' | 'warning' | 'failed' | 'unknown';
  detail: string | null;
};

export type ProjectSignals = {
  packageJson: boolean; devnexConfig: boolean; pnpmWorkspace: boolean; turbo: boolean;
  compose: string | null; envExample: boolean; git: boolean;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  /** registered = user added it (or found under a registered root); detected = found from a running process. */
  origin: 'registered' | 'detected';
  /** NEX Workbench's own repository: shown for visibility, never started or stopped from DevNEX. */
  self?: boolean;
  signals: ProjectSignals;
  packageManager: 'npm' | 'pnpm' | 'yarn' | null;
  services: Service[];
  status: ServiceStatus;
  /** CPU / RAM of processes tied to this project. `basis` says how they were tied, so attribution is never invented. */
  usage: ProjectUsage;
};

export type ProjectUsage = {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
  /** devnex = started by DevNEX (exact); inferred = matched by working directory / command line; none = nothing running. */
  basis: 'devnex' | 'inferred' | 'mixed' | 'none';
};

export type PortEntry = {
  port: number;
  address: string;
  exposure: 'loopback' | 'network';
  pid: number | null;
  processName: string | null;
  command: string | null;
  cwd: string | null;
  projectId: string | null;
  projectName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  /** Process could not be tied to any known project. */
  unknown: boolean;
  /** Started by an AI agent session (Agent Monitor), if known. */
  agent?: { sessionId: string; toolName: string; ended: boolean } | null;
};

export type PortConflict = {
  port: number;
  usedBy: { pid: number | null; processName: string | null; projectName: string | null; command: string | null };
  requestedBy: { projectId: string; projectName: string; serviceId: string; serviceName: string };
};

export type RuntimeTool = { name: 'node' | 'npm' | 'pnpm' | 'yarn' | 'docker' | 'git'; version: string | null };
export type RuntimeCheck = { tool: string; required: string; installed: string | null; source: string; status: 'ok' | 'mismatch' | 'missing' | 'unknown' };

export type EnvRow = {
  key: string;
  status: 'configured' | 'missing' | 'empty' | 'extra';
  /** Masked preview — raw values are never returned. */
  preview: string | null;
  sensitive: boolean;
  source: string | null;
};
export type EnvReport = { projectId: string; files: string[]; expectedFrom: string | null; rows: EnvRow[]; missing: number; configured: number };

export type GitInfo = {
  available: boolean; isRepo: boolean; path: string;
  branch: string | null; ahead: number; behind: number; changed: number; untracked: number; upstream: string | null; detail?: string;
};

export type Container = { id: string; name: string; image: string; state: string; status: string; ports: string; composeProject: string | null; workingDir: string | null; projectId: string | null };
export type DockerInfo = { available: boolean; detail: string | null; containers: Container[] };

export type IssueSeverity = 'critical' | 'warning' | 'info';
export type HealthIssue = {
  id: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  reason: string;
  recommendedAction: string;
  projectId: string | null;
  serviceId: string | null;
  port?: number;
  pid?: number;
};

export type LogLevel = 'info' | 'warning' | 'error';
export type LogLine = { seq: number; at: string; stream: 'stdout' | 'stderr' | 'system'; level: LogLevel; text: string };

export type DevnexOverview = {
  system: { memory: { total: number; used: number; available: number; percent: number }; cpu: { usage: number; cores: number; model: string }; swap: { total: number; used: number } };
  counts: { projects: number; services: number; running: number; failed: number; ports: number; unknownPorts: number; conflicts: number; issues: number };
  devProcesses: { memory: number; cpu: number; count: number };
  projects: Project[];
  issues: HealthIssue[];
  docker: { available: boolean; running: number; exited: number };
  runtimes: RuntimeTool[];
  updatedAt: string;
};
