# NEX Workbench — Architecture

## Shape

```text
Browser ── http://localhost:3900 ──► apps/workbench-web (Next.js, 127.0.0.1:3900)
                                       │  /api/*  (rewrite, same origin)
                                       ▼
                                     apps/workbench-api (NestJS, 127.0.0.1:3901)
                                       ├── SystemController     /system/*
                                       ├── MemnexController     /memnex/*
                                       ├── DevnexController     /devnex/*
                                       ├── WorknexController    /worknex/*
                                       ├── FilenexController    /filenex/*
                                       └── WorkbenchController  /workbench/*
                                       │
                         CoreService (one per process)
                           ├── PlatformAdapter (macOS | Windows)       packages/platform-core
                           │     + shared foreground cache (MemNEX + WorkNEX read the front window once)
                           ├── ProcessInventory (one `ps` per 2 s)      packages/process-core
                           ├── SystemMonitor (one RAM/CPU read per 1 s) packages/system-core
                           ├── EventBus + SSE                           packages/telemetry-core
                           └── Activity ring buffer (session only)      packages/logger
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
  modules/memnex (MemnexEngine)  modules/devnex (DevnexEngine)  modules/worknex (WorknexEngine)
                                         ▲                               │
                                         └── ProjectDirectory (wiring) ──┘   WorkNEX reads DevNEX projects, never rediscovers
```

There is one user-facing port. The API is an implementation detail that only the web app talks to.

## Layers and rules

| Layer | Knows about | Never |
|---|---|---|
| `packages/shared` | Plain types, the module contract | MemNEX/DevNEX concepts |
| `packages/platform-core` | The OS (`ps`, `vm_stat`, `lsof`, PowerShell…) | Product rules |
| `packages/process-core`, `system-core` | Generic process/system facts | Products |
| `modules/*` | Their own domain | HTTP, React, other modules |
| `apps/workbench-api` | Routing, wiring, error → HTTP mapping | Business rules |
| `apps/workbench-web` | Rendering, navigation | Detection logic |

`process.platform` is checked in exactly one place: `createPlatform()` in `platform-core`. Everything else uses the `PlatformAdapter` interface (`ProcessSource`, `MemorySource`, `PortSource`, `AppControl`, `ServiceControl`, `ShellOpen`…).

## Shared core, no duplicate polling

```text
               ProcessInventory  ◄── MemNEX snapshot
 (2 s TTL, shared in-flight)     ◄── DevNEX scan
                                 ◄── Workbench summary (via the modules)
               SystemMonitor     ◄── all of the above, 1 s cache
```

- MemNEX and DevNEX receive the same `platform` (wrapped with the shared inventory) and the same `SystemMonitor`.
- DevNEX caches a whole scan for 2.5 s, Docker for 10 s and runtime versions for 5 min; Git is read on demand.
- The MemNEX module adapter shares one snapshot between `getStatus()` and `getAttentionItems()`.
- The system ticker (memory/CPU SSE events) only runs while an SSE client is connected.

UI cadence: MemNEX polls every 3 s, DevNEX and the Workbench summary every 5 s, ×3 when *Relaxed* is chosen in Settings.

## Module contract

```ts
interface NexModule {
  id: string; name: string; route: string; description: string;
  getStatus(): Promise<ModuleStatus>;          // "My NEX" card
  getAttentionItems(): Promise<AttentionItem[]>; // Attention Center
  getCommands?(): Promise<NexCommand[]>;        // command palette
}
```

Each module decides what is wrong in its own domain. The Workbench (`WorkbenchService`) only aggregates, orders by severity and routes. Every module call goes through `settle()` with an 8 s timeout: a module that throws or hangs shows as *unavailable* and the rest of the Workbench keeps working.

Workspace status is deterministic (`workspaceState()` in `shared`): any critical item → **Critical**; any warning or unavailable module → **Attention**; otherwise **Healthy**.

## Events

`EventBus` (in-process) with SSE endpoints at `/memnex/events`, `/devnex/events` and `/workbench/events?topics=a.*,b.c`.

| Event | Emitted by |
|---|---|
| `system.memory.updated`, `system.cpu.updated` | MemNEX ticker (3 s, only while watched) |
| `memnex.memory.high`, `memnex.app.closed`, `memnex.cleanup.completed` | MemNEX |
| `worknex.context.started/resumed/ended/saved`, `worknex.collection.paused/resumed` | WorkNEX (derived only — never per app switch) |
| `devnex.service.started/stopped/failed`, `devnex.port.conflict`, `devnex.process.stopped`, `devnex.log` | DevNEX |

`CoreService` turns selected events into the session's Recent Activity (100-entry ring buffer).

## Frontend

- `app/layout.tsx` renders `WorkbenchShell` once: sidebar (with the active module's sections nested), theme, command palette (Cmd/Ctrl+K), summary poll, sidebar badges.
- `app/memnex/layout.tsx` and `app/devnex/layout.tsx` mount each module app in a **layout**, so state (data, selections, cleanup preview) survives navigation between that module's sections. `[[...section]]/page.tsx` only claims the URLs.
- `PageHeader` is the shared top bar: breadcrumb `NEX Workbench / Module / Page`, live status, Search, Local.
- The design system (`packages/ui`) is MemNEX's: same tokens, tiles, pills, tables, modals. New classes were appended; MemNEX rules were not changed.

## WorkNEX data flow

```text
OS front window ──► privacy-engine.sanitizeActivity ──► activity-engine.normalize ──► context-engine.ContextTracker
 (shared read)        untracked app / paused       app kind, file, DevNEX project     extend · switch · close
                      → dropped here                (memory ring, ≤ 1 h)                      │
                                                                                               ▼
                                     session-engine (timeline, sessions, insights, where-was-I, retention)
                                     resume-engine (plan → user selection → open via ShellOpen)
                                     history.json / saved.json (derived only, debounced 60 s)
```

`/workbench/summary` takes **Continue working** from `WorkNEX.getContinueWorkingItems()` (DevNEX running projects when WorkNEX is off).

Shutdown: SSE streams are closed in `CoreService.beforeApplicationShutdown`, with a 3 s hard-exit backstop, so `node --watch` restarts and Ctrl+C never hang on open browser connections.

## FileNEX data flow

```text
approved folders only ──► privacy-engine.approvedLocationFor (every path) ──► index-engine (stat only) ──► index.sqlite
       ▲                                                                                                    │
  explicit Add folder                     WorkNEX contexts ─┐   DevNEX projects ─┐   system pressure ─┐       ▼
  (DevNEX/WorkNEX never grant it)                           └──────────┬─────────┘                    └► throttle
                                                                       ▼
                     search-engine · relationship-engine · version-engine · duplicate-engine (read-only over the index)
```

Storage Intelligence (`/filenex/storage/*`, `FilenexStorageController`) uses the same allowlist:

```text
OS statfs (no folder access) ──► disk-analyzer ──► status · forecast
approved folders only ──► storage-engine/walker (lstat sizes, symlinks never followed) ──► storage-history (index.sqlite)
DevNEX projects + running services ─┐  WorkNEX recent use ─┐  docker system df ─┐  MemNEX load ─► defer/throttle
                                    └──────────────┬──────┴───────────────────┘
                                                   ▼
             dev-storage-engine (repo footprint, risk) ──► cleanup (candidates + preview) ──► executor (confirmed items only, re-checked)
```

## Adding a future module

1. `modules/<id>` — engine + `create<Id>Module(engine): NexModule`.
2. `apps/workbench-api/src/<id>/` — service (wiring) + controller (`/<id>/*`); add the module to `WorkbenchService.all`.
3. `apps/workbench-web/modules/<id>/` + `app/<id>/layout.tsx` + `app/<id>/[[...section]]/page.tsx`.
4. One entry in `apps/workbench-web/shell/modules.ts`.

Unimplemented modules are deliberately not listed anywhere.

## Safety model

- Loopback bind + `checkLocalRequest()` (Host and Origin) on every API request.
- Every destructive endpoint requires `{ "confirmed": true }`.
- Protection is enforced in the engines, not the UI: OS processes (`classifyProcess`), NEX itself and its host app, and user-protected apps are refused by both MemNEX and DevNEX (one shared protected-apps list).
- DevNEX runs only commands from the project's own files, refuses to start into an occupied port, and never escalates a stop to a kill.
