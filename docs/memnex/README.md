# MemNEX — Local System Intelligence

**Smart Cleanup. Not Blind Cleanup.** Route: `/memnex`

MemNEX answers *“Is my computer OK, and if not, why?”* using real data from the OS, and suggests closing apps you are **not using** — never just the biggest ones.

| Section | Route | What it shows |
|---|---|---|
| Overview | `/memnex` | Diagnosis (one cause, evidence, ≤ 2 actions), memory in use with the signals behind the verdict, available / swap / CPU, top consumers, this machine |
| Processes | `/memnex/processes` | Apps grouped from processes; search, filters (`?filter=high` deep-link), sort; expand for PIDs; command-line tools stopped one process at a time |
| Smart Cleanup | `/memnex/cleanup` | Idle-app suggestions, optional extras, *Restart to reclaim* for growing apps, real before → after result with Reopen |
| Settings | `/memnex/settings` | Appearance (shared), protected apps, learned “usually keep open”, local data |

## Rules (all deterministic)

- **Health**: on macOS the OS memory-pressure level wins; otherwise used % (70 / 85 / 95) plus *active* swapping (≥ 1 MB/s over 60 s).
- **Idle app**: not in front for ≥ 20 min while you were present, < 5 % background CPU, ≥ 200 MB, not system/protected/host. Pre-selected only under memory pressure.
- **Growth**: +500 MB and +30 % over ≥ 10 min and still high in the last 3 samples → *Restart* suggestion.
- **Learning**: unchecked suggestions count up; after 3, MemNEX stops suggesting that app.

The full design rationale (tokens, components, copy, thresholds) is in [`design.md`](../../design.md).

## Safety

- Quit asks the app to close like its own Quit menu (AppleScript / `CloseMainWindow`); waits up to 5 s.
- Force close is never automatic and never part of cleanup; it needs a separate confirmation.
- The API refuses: OS processes, NEX Workbench itself, the app NEX runs inside, protected apps, and any request without `confirmed: true`.
- Reopen only works for apps MemNEX closed in the last hour.

## Code

| Concern | Location |
|---|---|
| Engine facade | `modules/memnex/src/engine.ts` |
| Health / growth | `modules/memnex/src/memory-engine/` |
| Activity, recommendations, diagnosis | `modules/memnex/src/recommendation-engine/` |
| Protection, preferences | `modules/memnex/src/protection-engine/` |
| Cleanup, history, reopen | `modules/memnex/src/cleanup-engine/` |
| Workbench adapter (status, attention, commands) | `modules/memnex/src/module.ts` |
| HTTP | `apps/workbench-api/src/memnex/` |
| Screens | `apps/workbench-web/modules/memnex/MemnexApp.tsx` |

## API (`/api/memnex/*` via :3900)

`GET snapshot`, `GET cleanup-preview`, `POST processes/:pid/{quit|kill|restart}` *(confirmed)*, `POST cleanup` *(confirmed)*, `POST apps/reopen`, `GET icon/:pid`, `GET settings`, `POST settings/protected`, `POST settings/suggest-again`, `GET history`, `GET events` (SSE).
