# NEX Workbench

**Local tools. Local data. Local control.**

NEX Workbench is a local-first work intelligence platform. It runs entirely on your computer — no cloud, no account, no remote database, no telemetry.

```text
NEX Workbench            http://localhost:3900
│
├── MemNEX               /memnex
│   Local System Intelligence — Smart Cleanup. Not Blind Cleanup.
│
├── DevNEX               /devnex
│   Local Developer Control Center — Know what’s running. Fix what’s broken.
│
├── WorkNEX              /worknex
│   Work Continuity Intelligence — Pick up where you left off.
│
└── FileNEX              /filenex
    Local File Intelligence — Find the work, not the filename.
```

## Quick start

Requires **Node.js ≥ 22.13** and npm (macOS or Windows).

```bash
npm install
npm run dev
```

Open **http://localhost:3900**. That is the only address you need: Home, MemNEX, DevNEX, WorkNEX and FileNEX all live there.

## npm commands

| Command | What it does |
|---|---|
| `npm run dev` | Builds the shared packages, then runs the API, the web app and a TypeScript watcher together |
| `npm test` | Compiles and runs every unit test (`node --test`) |
| `npm run typecheck` | Type-checks packages, modules, the API and the web app (`npm run lint` is an alias) |
| `npm run build` | Production build of packages, API and web app |
| `npm start` | Runs the production build (after `npm run build`) |
| `npm run clean` | Removes build output (`dist`, `.next`); never touches local data |

## Ports and network

| Port | Process | Reachable from |
|---|---|---|
| **3900** | Web app (Next.js) — the user-facing UI | `127.0.0.1` only |
| 3901 | Workbench API (NestJS) — internal, proxied by the web app under `/api/*` | `127.0.0.1` only |

- Both servers bind to **127.0.0.1**, never `0.0.0.0`. Nothing is exposed to your LAN or the internet.
- The API rejects requests whose `Host` is not a loopback address (DNS rebinding) and whose `Origin` is not the Workbench (cross-site requests).
- Override with `NEX_WEB_PORT`, `NEX_API_PORT`, `NEX_WEB_HOST`, `NEX_API_HOST` — only if you know you need to.

## Repository layout

```text
apps/
  workbench-web/      Next.js shell: Home, Settings, command palette, /memnex/*, /devnex/*
    shell/            Workbench-owned UI (sidebar, top bar, palette, Home, Settings)
    modules/memnex/   MemNEX screens
    modules/devnex/   DevNEX screens
    modules/worknex/  WorkNEX screens
    modules/filenex/  FileNEX screens
  workbench-api/      NestJS: /system, /memnex, /devnex, /worknex, /filenex, /workbench controllers (wiring only)
modules/
  memnex/             MemNEX domain logic (health, recommendations, protection, cleanup)
  devnex/             DevNEX domain logic (projects, services, ports, env, runtime, git, docker, health)
  worknex/            WorkNEX domain logic (activity, context, session, resume, privacy engines)
  filenex/            FileNEX domain logic (privacy, index, search, relationship, version, duplicate engines;
                      storage: disk-analyzer, storage-engine, storage-history, dev-storage-engine)
packages/
  shared/             Product-agnostic types + the module contract (NexModule, AttentionItem)
  platform-core/      OS adapters (macOS, Windows) — the only place that branches on the OS
  process-core/       One process inventory, grouping, classification, graceful control
  system-core/        RAM / CPU / swap / host
  telemetry-core/     In-process event bus + Server-Sent Events
  config/             Ports, loopback guard, small JSON stores
  logger/             Leveled logger + bounded ring buffer
  ui/                 Design system (tokens, components) extracted from MemNEX
docs/                 Architecture and per-module docs
```

See [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) for how the pieces fit.

## MemNEX

RAM, CPU and swap monitoring, apps grouped from processes, a deterministic diagnosis, protected apps, Smart Cleanup with preview and before/after measurement. Graceful quit first; force close only after explicit confirmation. → [docs/memnex/README.md](docs/memnex/README.md)

## DevNEX

Projects, their services and ports; port ownership and conflict detection; CPU/RAM per project; live logs for services it starts; `.env` validation with masked values; runtime, Git and Docker context; deterministic issues with recommended actions. → [docs/devnex/README.md](docs/devnex/README.md)

## WorkNEX

Remembers your **work contexts** — a project across editor, terminal and localhost browser tabs; a family of documents — so you can see where you stopped and **Resume** (with a preview of exactly what will open). Timeline, save points, *Where was I?*, descriptive insights.

**No consent, no tracking.** WorkNEX tracks nothing until you add apps to its allowlist (WorkNEX › Settings › Tracked applications). Each app starts at *Presence* (name and time only); window titles, files and URLs are separate, per-app opt-ins. Untracked apps leave no trace. Pause anytime; raw activity is never written to disk; no scores. → [docs/worknex/README.md](docs/worknex/README.md)

> On macOS, window titles need Accessibility permission for the app running `npm run dev`.

## FileNEX

Search your files by work — project, WorkNEX context, type, date — with *Why this result?*, related files, version groups with a *likely latest* hint, and exact/possible duplicates. **No folder permission, no indexing**: nothing is indexed until you add folders. Metadata only; never deletes, moves or renames files. Local SQLite index.

**Storage Intelligence** (`/filenex/storage`): disk used/free with a deterministic status (Healthy · Attention · Low · Critical), where the space went inside approved folders, large files, What grew? and a simple forecast from local snapshots, and **Developer Storage** — DevNEX repositories ranked by size with source / dependencies / build / cache / logs / Git / Docker breakdowns. Cleanup Review classifies every candidate (Safe to review · Review carefully · Protected) and previews exact paths; **FileNEX never deletes anything**. DevNEX registration never grants scan permission. → [docs/filenex/README.md](docs/filenex/README.md)

### Registering projects (DevNEX)

DevNEX finds projects three ways:

1. **Automatically** — any dev server listening on a port is traced to its project folder.
2. **Add a project** — DevNEX › Projects › *Add a project folder*.
3. **Add a folder of projects** — DevNEX › Settings › *Project folders* (scanned two levels deep, never the whole disk).

### `devnex.config.json` (optional)

Put it in a project root to name the project and declare services precisely. Without it, DevNEX uses `package.json` `dev*` scripts and compose files.

```json
{
  "name": "SmartFlowNEX",
  "services": [
    { "name": "frontend", "type": "frontend", "command": "npm run dev:web", "port": 3000 },
    { "name": "backend", "type": "backend", "command": "npm run dev:api", "port": 4000 }
  ]
}
```

`type` is one of `frontend`, `backend`, `database`, `cache`, `worker`, `queue`, `container`, `app`. Commands are only ever read from this file or `package.json` — never accepted from the browser.

## Security and privacy

- Localhost only; no telemetry (Next.js telemetry is disabled too); the UI font is bundled, so the app makes no network requests.
- Nothing is killed automatically. Every quit/stop needs confirmation; force close is MemNEX-only and never part of cleanup.
- Operating-system processes, NEX Workbench itself, the app NEX runs inside, and your protected apps are refused by the API — not just hidden in the UI.
- `.env` values are masked before they leave the API and are never stored or logged. DevNEX never edits `.env` files, installs runtimes, or changes Git state.

## Local data

Small JSON files (and FileNEX’s SQLite index) next to the API (`apps/workbench-api/`):

| Folder | Contents |
|---|---|
| `.nex/` | Workbench preferences (enabled modules, refresh) |
| `.memnex/` | Protected apps, learned preferences, app-usage timestamps, icon cache |
| `.devnex/` | Registered projects and project folders |
| `.worknex/` | WorkNEX allowlist + settings, derived work contexts (retention-limited), save points |
| `.filenex/` | FileNEX indexed locations + settings, storage settings, `index.sqlite` (file metadata, collections, storage snapshots, latest storage analyses) |

Logs, raw WorkNEX activity, recent activity and cleanup history live in memory and disappear when NEX stops. All of these folders are git-ignored.

## Known limitations

- **Windows**: the adapter is implemented but has not yet been verified on a real Windows machine. Working-directory lookup isn’t available there, so DevNEX ties processes to projects by command line only.
- Logs are available only for services started from DevNEX (it can’t attach to an existing terminal).
- DevNEX reads Docker status but doesn’t start or stop containers.
- Runtime checks cover Node.js, npm, pnpm and yarn.
- Recent Activity is per session (in memory).
- WorkNEX observes only the front window, and only of apps you added; on macOS titles need Accessibility permission (see the WorkNEX doc).
- Starting a project starts each service; there is no dependency ordering between services yet.
