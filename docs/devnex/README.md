# DevNEX — Local Developer Control Center

**Know what’s running. Fix what’s broken.** Route: `/devnex`

DevNEX is project-centric: it understands projects and their services, then shows the processes and ports behind them.

| Section | Route | What it shows |
|---|---|---|
| Overview | `/devnex` | Development status (Healthy / Warning / Critical), memory, projects/services/ports running, issues, toolchain, active project cards |
| Projects | `/devnex/projects` | Registered and detected projects; add a folder |
| Project detail | `/devnex/projects/:id` | Status, branch, path; Open folder / Open in browser / Start / Restart / Stop; services, resource usage, issues, Git, runtime, Docker, environment, logs |
| Services | `/devnex/services` | Every service with status, port, CPU, RAM, PID; Start / Stop / Restart / Logs |
| Ports | `/devnex/ports` | Port · process · PID · project · service, search/filter/sort, conflicts with *View process / Stop process / Ignore* |
| Logs | `/devnex/logs` | Live output of services DevNEX started: pause, auto-scroll, search, level filter, copy, clear (2 000 lines, memory only) |
| Environment | `/devnex/environment` | `.env*` vs `.env.example`, masked values; installed runtimes vs project requirements |
| Settings | `/devnex/settings` | Project folders, registered projects, protected apps (shared with MemNEX), Docker status, safety |

## How projects are found

1. A listening port → its process → working directory (or command line) → nearest project root (stops at `.git` / `devnex.config.json`, never above `$HOME`).
2. Folders you register (Projects › Add).
3. Project folders you register (Settings), scanned two levels deep.

Signals: `package.json`, `devnex.config.json`, compose files, `pnpm-workspace.yaml`, `turbo.json`, `.env.example`, `.git`. Registered paths are stored in `apps/workbench-api/.devnex/projects.json`.

## Services

From, in order of authority: `devnex.config.json` → `package.json` `dev`/`dev:*` (or `start`/`serve`/`watch`) scripts → compose file. Ports come from the config or from `-p`, `--port`, `PORT=` in the script.

Status: `STOPPED`, `STARTING` (started < 60 s ago, port not open yet), `RUNNING`, `WARNING` (running but port never opened), `FAILED` (exited unexpectedly), `UNKNOWN` (no port to check / Docker unavailable).

## Port conflicts

A conflict is a service that declares a port held by a process that is not that service. Starting refuses and explains:

```text
Cannot start frontend. Port 3000 is already in use.
Owner: node · PID 18342 · Project: old-test-project. Nothing was stopped.
```

Starting a whole project checks every port first; if any is taken, nothing starts. DevNEX never kills anything on its own.

## Resource attribution

Per project: CPU, RAM, process count, summed over the process trees of its services and of ports tied to it. The `basis` is shown so it is never overstated: *Exact* (DevNEX started it), *Inferred* (matched by working directory / command line), *Mixed*.

## Health rules

| Issue | Severity |
|---|---|
| Port conflict | critical |
| Service crashed (non-zero exit, not requested) | critical |
| Service running but port not open | warning |
| Dev service ≥ 1.5 GB RAM | warning |
| Database service not listening | warning |
| Missing / empty variable from `.env.example` | warning |
| Runtime version mismatch / tool missing | warning |
| Container exited with an error | warning |
| Orphaned dev server (parent terminal gone) | warning |
| Dev server reachable from the network | info |

Each issue carries a description, likely cause and recommended action.

## Safety

- Commands are read only from the project's files; the API never accepts a command.
- Stop is graceful (SIGTERM to the process group / `taskkill` without `/F`); there is no force option.
- Refused: OS processes, NEX Workbench itself (its own project is shown read-only), and apps protected in MemNEX.
- `.env` values are masked in the API (`sk-****8Jx`, `postgres://****:****@host/db`) and never stored or logged. Files are never edited.
- Git is read-only. Docker is read-only and optional — DevNEX degrades gracefully if it is missing or stopped.

## Code

| Concern | Location |
|---|---|
| Engine facade (scan, actions) | `modules/devnex/src/engine.ts` |
| Discovery, services, registry, runner | `modules/devnex/src/project-engine/` |
| Ports, conflicts, process→project | `modules/devnex/src/port-engine/` |
| Env, runtime, git, docker | `modules/devnex/src/{environment,runtime,git,docker}-engine/` |
| Health rules | `modules/devnex/src/service-health/` |
| Workbench adapter | `modules/devnex/src/module.ts` |
| HTTP | `apps/workbench-api/src/devnex/` |
| Screens | `apps/workbench-web/modules/devnex/DevnexApp.tsx` |

## API (`/api/devnex/*` via :3900)

`GET overview | projects | projects/:id | ports | environment | registry | services/:id/logs | events`;
`POST projects` `{path}`, `POST roots` `{path}`, `POST projects/:id/{start|stop*|restart*|open-folder|remove}`, `POST services/:id/{start|stop*|restart*}`, `POST services/:id/logs/clear`, `POST processes/:pid/stop*` — `*` requires `{ "confirmed": true }`.
