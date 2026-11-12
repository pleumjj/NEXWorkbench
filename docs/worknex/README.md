# WorkNEX — Work Continuity Intelligence

**Pick up where you left off.** Route: `/worknex`

WorkNEX is a local memory layer between your apps, files, projects and browser — and your own memory. It answers *What was I working on? Where did I stop? What do I reopen to continue?*

> **Remember the work, not the worker.** WorkNEX helps you resume your own work. It is not time tracking, monitoring, attendance or a productivity score — and it has no way to become one: there is no account, no upload, no score, and no screenshot/keystroke/clipboard code.
>
> **No consent, no tracking.** WorkNEX tracks **nothing** until you add applications to its allowlist. Being visible to the operating system is not permission for WorkNEX to remember it.

## Explicit tracking, never ambient tracking (allowlist)

A fresh install has **0 tracked applications** and collects nothing — WorkNEX doesn't even read the front window. The first screen explains this and offers **Choose apps to track**.

```text
OS front window ─► identify app (no title) ─► on the allowlist?
                                              ├─ no  → DROP: not stored, not grouped, not in timeline, not logged, not emitted
                                              └─ yes → apply the app's level → strip what isn't granted → activity → context
```

- **Add application** (WorkNEX › Settings) lists running and installed apps. Nothing is pre-selected and there is no “select all”. Discovery is not consent; listing apps writes nothing.
- Apps are matched by **stable identity** — bundle id (macOS) or executable path (Windows) — never by display name.
- **Per-app levels** (new apps start at Presence):

| Level | WorkNEX knows | Browser |
|---|---|---|
| 1 · Presence | app name, when it was in front, for how long | browser name and time |
| 2 · Context | + window title, project/folder (from the app’s own terminals) | + project via localhost ports (no tab titles) |
| 3 · Extended | + file names (title, open documents) | + tab titles |
| URL (separate switch) | — | active tab URL; off unless you turn it on for that browser |

  “Defaults for newly added apps” (window titles / file names / URLs) are all **off**.
- **Untracked apps leave no trace**: switching to one simply ends the current stretch — the timeline shows a gap, nothing says which app it was, and it never contributes to grouping, Active context, Where was I? or Resume.
- **Stop tracking** takes effect immediately and asks you to choose: *Keep existing history* or *Remove app & delete history* (removes that app and the files/URLs/titles it contributed from WorkNEX contexts and save points; contexts left with no tracked app are deleted). Files, app data, browser history, DevNEX and MemNEX are never touched.
- **Pause WorkNEX** stops collection from every tracked app until you resume.
- Launching an app via Resume never adds it to the allowlist — tracking consent and launching are separate decisions.
- General settings (`PUT /settings`) cannot change the allowlist; only the tracked-apps endpoints can.

| Section | Route | What it shows |
|---|---|---|
| Overview | `/worknex` | Active context, **Where was I?**, contexts today, Continue working, Save context, Pause |
| Timeline | `/worknex/timeline` | Work contexts (not app events) for Today, Yesterday and earlier days |
| Timesheet | `/worknex/timesheet` | Your own daily / weekly summary of minutes per work item, rounded to 0.5 h, CSV download — e.g. to fill in Workforce |
| Contexts | `/worknex/contexts` | All recent contexts; detail at `/worknex/contexts/:id` |
| Saved | `/worknex/saved` | Your save points, with Resume |
| Insights | `/worknex/insights` | Descriptive facts: major contexts, longest uninterrupted stretch, average context, back-and-forth |
| Settings | `/worknex/settings` | Tracking, privacy, history/retention, resume defaults, status |

## Tracking model

When at least one app is tracked, every **5 s** (10 s on Windows) WorkNEX identifies the app in front (one read shared with MemNEX). Everything below applies **only to tracked apps, only at the level granted**:

| Signal | Source | Needs |
|---|---|---|
| App name, bundle id / exe, pid | `lsappinfo` (macOS), `GetForegroundWindow` (Windows) | nothing |
| Idle time | `ioreg` HIDIdleTime / `GetLastInputInfo` | nothing |
| Window title | System Events (macOS), `GetWindowText` (Windows) | **macOS: Accessibility permission** |
| Project | window-title segment = project name · working folder of the app's own terminals/shells · localhost port of a running service — matched against **DevNEX** projects | nothing |
| File | file name in the title · documents the app holds open (`lsof`, macOS) | nothing (names only) |
| URL | active tab of Chrome-family / Safari (macOS) | **off**; explicit per-browser switch + browser Automation permission |

Raw observations stay **in memory only** (≤ 1 hour, ≤ 720 samples). Only derived **work contexts** are written to disk.

## Context grouping

Deterministic, conservative rules — it is better to show two contexts than to merge unrelated work.

1. **Meeting** apps (Zoom, Teams, Webex, FaceTime, Google Meet tabs) → a meeting context.
2. **DevNEX project** (editor, terminal and `localhost:<port>` browser tabs of one project) → one development context.
3. **Document family**: the leading token of the file name, ≥ 4 characters, not generic and not a date — `ISO29110_Executive_v6.pptx` + `ISO29110_Cost.xlsx` → *ISO29110*. Otherwise one context per file.
4. Otherwise: browsing (per browser) or the app itself.

The same key continues the same context if it comes back within a window (projects 4 h, documents 2 h, apps/browsing 30 min, meetings 15 min); after that, a new context starts. Ambiguous evidence (two projects, no title) never assigns a project.

## Sessions and timeline

- Idle ≥ *idle minutes* (default 10) in a tracked app, switching to an untracked app, or Pause ends the current stretch (an untracked app shows as a gap — never by name).
- An interruption shorter than 3 minutes between two stretches of the same context is merged (“brief switch to Slack”).
- Glances under 1 minute are folded into the neighbouring entry.
- When a context stops, WorkNEX records why only when the evidence is clear: *“Context changed when Microsoft Teams became active.”* or *“You stepped away.”*

## Timesheet — your own summary for Workforce

A summary **you** read and copy into your timesheet tool. It is computed on demand from your tracked work contexts and never sent anywhere.

- **What counts**: time a *tracked* app was in front while you were active, plus a tracked meeting app while a call is running.
- **Meetings in the background**: once you were in a meeting (Teams, Zoom, Webex… on your list), it keeps counting while you switch to other windows — as long as the meeting app is still busy with audio/video (≥ 5 % CPU; an open-but-idle meeting app uses ~0 %). It ends when that activity stops, or after 4 hours without returning to the meeting app. Being idle while listening doesn’t end a call. Meetings in a browser tab (Google Meet) count only while in front.
- **No double counting**: time that overlaps a meeting belongs to the meeting.
- **Not counted**: untracked apps, idle time, paused periods.
- **Rows**: one per work item per day (the same project across the day is one row). Daily view shows exact `h m` and hours rounded to the nearest **0.5** (2 h 14 m → 2.0, 2 h 15 m → 2.5). Weekly view: Mon–Sun × work items. **Download CSV** (`Date, Work, Type, Project folder, Minutes, Hours (rounded 0.5)`, UTF-8 with BOM for Excel).
- To split time **per project** (not just per app), give editors/terminals the *Context* level.

## Save Context — save points for work

**Save context** snapshots references: project folder, Git branch, apps (bundle id / path), files, URLs (if tracked), DevNEX services, your label and note. Never application memory, window state or file contents. Save points are kept until you delete them (retention doesn’t remove them).

## Resume

Resume always starts with a **preview** (unless you turn off *Confirm before opening resources*):

```text
Resume SmartFlowNEX — will open:
☑ Open project in Visual Studio Code     (the editor you used, via the OS — not a VS Code integration)
☑ Open project folder
☐ Open a terminal in the project
☑ Open frontend · localhost:3000         (only if the service is running in DevNEX)
☑ Open DevNEX project
☑ Open version.service.ts                (only files whose path is known and that still exist)
```

Missing files and stopped services are listed but can’t be selected. The server re-derives the plan and opens only ids from it — a request can’t inject a path or command.

## Where was I?

The most recent *meaningful* context (≥ 3 min, not a meeting, or saved), its last file, related local URLs (live from DevNEX) and — when clear — what interrupted it. Available on the Overview, Home quick actions and the command palette.

## Privacy model

- The **privacy engine runs first** (`sanitizeActivity()` returns `null` for anything not allowed). Nothing downstream — activity, contexts, timeline, events, logs, disk — sees an untracked app.
- The OS is asked for a window title, folders, open files or a URL **only** for a tracked app with that permission, and only after confirming the same app is still in front.
- **Excluded folders** still apply inside tracked apps: their files/projects never reach a context; titles mentioning them are dropped.
- Never collected, by design: screenshots, OCR, keystrokes, clipboard, document/page content, audio, transcripts, browser history.
- Nothing leaves the machine. Only derived events (`worknex.context.started/saved/resumed`, `worknex.collection.paused/resumed`, `worknex.app.tracked/untracked`) reach the Workbench event bus — never individual app switches, never untracked apps.
- The Overview shows a privacy summary — tracked apps, apps with detailed access, URL tracking, status — and the top bar shows a subtle *WorkNEX · N apps* indicator (or *WorkNEX paused*).

## Local storage and retention

`apps/workbench-api/.worknex/` (git-ignored):

| File | Contents |
|---|---|
| `settings.json` | The allowlist (tracked apps and their levels) and other settings |
| `history.json` | Work contexts (title, apps + time, up to 12 file names, up to 8 URLs if tracked, spans, interruptions) — written at most once a minute |
| `saved.json` | Save points |

Retention (7 / 30 / 90 days or custom 1–365) deletes old contexts hourly and on startup; glances under 30 s are dropped once they end. **Clear work history** deletes `history.json` content (and, if you tick it, save points). MemNEX, DevNEX, your files and Git repositories are never touched.

JSON rather than SQLite: the data is small, derived and bounded, it matches the rest of the Workbench, and it needs no native dependency.

## Integration

- **DevNEX**: projects, paths, services, ports and Git branch come from DevNEX — WorkNEX never rediscovers them. Context detail shows live service state; Resume opens running service URLs and the DevNEX project.
- **Shared core**: one foreground read shared with MemNEX; process tree and RAM from the shared process core (“This context currently uses approximately 3.8 GB of RAM”).
- **Workbench Home**: the *WorkNEX* card and **Continue working** (falls back to DevNEX’s running projects if WorkNEX is turned off).
- **Command palette**: Open WorkNEX · Where was I? · Save current context · Show today’s timeline · Pause / Resume WorkNEX · Resume *<context>* · Resume saved *<label>*.
- **Workbench Home** with no tracked apps: a neutral *Not configured* card with **Choose apps** — never an error.
- **Attention** (info only, conservative): window titles unavailable for a tracked app; a save point not resumed for 7 days; a development context left > 1 h ago whose services are still running. Switching contexts is never an issue.

## API (`/api/worknex/*` via :3900)

`GET tracked-apps | tracked-apps/:id | available-apps` · `POST tracked-apps` `{applicationId, displayName, bundleId?, executable?}` · `PUT tracked-apps/:id` `{level?, url?, enabled?}` · `DELETE tracked-apps/:id?deleteHistory=true|false` (choice required) ·
`GET timesheet?from=YYYY-MM-DD&to=YYYY-MM-DD | timesheet.csv?from&to` ·
`GET status | active-context | where | recent | contexts | contexts/:id | timeline?day=YYYY-MM-DD | insights?day= | saved | settings` ·
`POST contexts/:id/save` `{label, note}` (`:id` may be `current`) · `DELETE saved/:id` ·
`POST {contexts|saved}/:id/resume-preview` · `POST {contexts|saved}/:id/resume` `{itemIds, confirmed: true}` ·
`PUT settings` · `POST pause` · `POST resume-tracking` · `DELETE history?confirmed=true[&includeSaved=true]`

## Limitations

**macOS**
- Window titles (Context/Extended levels) need **Accessibility** permission for the app that runs `npm run dev` (Terminal, iTerm, VS Code…): System Settings › Privacy & Security › Accessibility. Without it WorkNEX shows *Limited activity detection* and records those apps at presence level (plus project via terminal folders at Context). After a refusal it waits 10 minutes before asking the OS again.
- URL tracking (if enabled) asks for Automation permission per browser; Firefox is not supported.
- Open-document detection covers apps that keep the file open (Office, Preview, Pages/Keynote…).

**Windows** (implemented, not yet verified on a real machine)
- The app picker lists running apps only (installed-app enumeration isn’t implemented).
- Titles work without permission. URLs and open-document detection are not available. Working folders of other processes aren’t exposed, so projects come from titles and localhost ports.
- “Open with” uses the app’s executable path; “Open terminal” prefers Windows Terminal, else `cmd`.

**General**
- Only the front window is observed — background tabs/windows aren’t known.
- Resume reopens resources; it can’t restore unsaved work or an app’s previous windows.
- Meetings are inferred from app names only; no calendar, no content.
