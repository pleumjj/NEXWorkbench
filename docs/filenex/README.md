# FileNEX — Local File Intelligence

**Find the work, not the filename.** Route: `/filenex`

FileNEX helps you find and understand files by **work context** — which project, which WorkNEX context, which version — instead of exact names and folders. It is not a file manager: Finder / Explorer stay in charge of files. FileNEX only indexes metadata, suggests, and explains. It never deletes, moves, renames or overwrites anything.

| Section | Route | What it shows |
|---|---|---|
| Overview | `/filenex` | Search box, index status, Recent work (from WorkNEX), recent files |
| Search | `/filenex/search?q=` | Results with type/date/location filters, “Likely latest”, project/context tags, **Why this result?** |
| File detail | `/filenex/files/:id` | Details · Open · Reveal in folder · Copy path · related work · related files (with reasons) · possible versions · duplicate status · add to collection |
| Collections | `/filenex/collections` | WorkNEX contexts, DevNEX projects (only inside indexed folders), your own collections |
| Versions | `/filenex/versions` | Possible version groups with a *likely latest* hint |
| Duplicates | `/filenex/duplicates` | Exact and possible duplicates (informational) |
| Storage | `/filenex/storage/…` | Storage Intelligence: Overview · Large Files · Developer Storage · Duplicates · Growth · Cleanup Review (see below) |
| Settings | `/filenex/settings` | Indexed locations, indexing, exclusions, privacy, storage analysis, developer storage, performance, index storage |

## No folder permission, no indexing (allowlist)

A fresh install indexes **0 folders and 0 files**. You add folders explicitly (Settings › **Add folder** — browse or type a path). Broad folders (home, Desktop, Downloads, Documents themselves) ask for confirmation; the whole disk and OS folders are refused.

```text
walk an approved folder ─► every path: inside an active approved location?
                             ├─ no  → ignored (never recorded)
                             └─ yes → exclusion rules → metadata (stat) → FileNEX index
```

- Discovery only ever **starts inside** approved folders and never follows symlinks out of them; each candidate is re-checked against the allowlist before it becomes a record.
- **Registering a project in DevNEX does not grant permission.** **A file seen by WorkNEX does not grant permission.** Those files are used only if they are inside a folder you added.
- **Pause** a folder or all of FileNEX: nothing is scanned or updated; search over the existing index still works.
- **Remove** a folder: indexing stops immediately (a running scan aborts and writes nothing). You choose to *Keep index data* or *Remove & delete index data*. Files on disk are never touched.

## What is indexed

Metadata only: name, extension, path, folder, size, created/modified time, file type. **File contents are not read** — the single exception is hashing files whose sizes are identical, to confirm exact duplicates (≤ 256 MB, throttled, ≤ 400 per pass). Content indexing and OCR are not part of v1 (the setting is shown, disabled).

**Excluded by default**
- Folders: `node_modules .git .next dist build out coverage tmp temp cache .cache __pycache__ .venv venv target .gradle .idea Pods DerivedData .turbo .parcel-cache .terraform` (editable)
- Extensions: `log tmp temp swp swo crdownload part lock pyc class o obj` (editable)
- Hidden files and folders (opt-in)
- **Sensitive names** — `.env*`, *credentials*, *secret(s)*, *password(s)*, *private key*, *token*, `id_rsa`/`id_ed25519`, and `.pem .p12 .pfx .kdbx .keychain .asc .gpg .ovpn .ppk .jks` — not even their names are indexed (toggle). `.key` is deliberately allowed: on macOS it is a Keynote file.
- macOS app bundles and libraries (`.app`, `.photoslibrary`…); document packages (`.pages`, `.numbers`, `.key`, `.rtfd`…) are indexed as one file.

## Indexing engine

- First scan when a folder is added; then **watch** the folder (recursive `fs.watch`, macOS + Windows) and re-scan it 15 s after changes; plus **periodic reconciliation** (15 min / hourly / 6 h / daily / only on demand).
- One folder at a time, throttled between batches of 250 entries; **backs off** (slower scans, background scans wait) when the shared system monitor reports memory pressure or CPU > 85 % — the same signal MemNEX uses.
- Only changed records are written; records of files that disappeared are removed.
- Status per folder: *Indexed · Scanning (N files scanned) · Paused · Unavailable · Error*; overall *Idle · Scanning · Updating · Paused · Error*.

## Search

Deterministic and explainable — no LLM, no embeddings.

- **Query understanding**: types (`presentation/slides/deck/ppt`, `excel/spreadsheet/xlsx/csv`, `word/doc`, `pdf`, `image/photo`, `code`, `notes/md`…) and dates (`today`, `yesterday`, `this/last week`, `this/last month`, `last N days`, `recent`). *“presentation modified yesterday”* → type = presentation, modified = yesterday. *“excel from ISO29110”* → type = spreadsheet, words = iso29110.
- **Ranking signals**: whole phrase in the name, name word matches, partial matches, one-typo tolerance (≥ 5 letters), DevNEX project name, WorkNEX context title, folder path, recency, recent WorkNEX use, likely-latest version (older versions sink).
- About 60 % of the words must match somewhere — forgiving, not random.
- Every result can show **Why this result?** (e.g. *Filename contains “iso29110” · Used in WorkNEX context “ISO29110 Executive Presentation” · Modified this week*).
- From anywhere: **⌘K / Ctrl+K**, type a query → *Search files for “…”*.

## Related files

Signals with reasons: used together in a **WorkNEX context** (strong), in the same **collection** (strong), **similar name** family — e.g. both start with `ISO29110` (strong), modified within 30 min, same folder, same DevNEX project. Weak signals never qualify alone: a strong signal, or changed together in the same folder, is required. Version siblings are shown under *Possible versions* instead.

## Version intelligence

Names are normalised by removing `final`, `final2`, `latest`, `new`, `draft`, `copy`, `copy 2`, `(1)`, `v1`/`v03`/`version 2`, `revA`/`revB`, dates (`2024-11-05`, `20241105`) — and grouped with the same extension in the same folder (or its `old`/`archive`/`backup`/`versions` subfolder).

**Likely latest** = most recently modified. If another file carries a higher version number, FileNEX says so (*“proposal_v6.docx has the highest version number, but proposal_final2.docx was modified more recently”*). It never claims certainty.

## Duplicates

- **Exact**: same size **and** same SHA-1 (hashing only size-matched candidates).
- **Possible**: same name apart from “copy”/numbering, plus same size, modification within 2 minutes, or a copy-style name.
- Actions: compare details, open the file page, reveal in folder. Extra exact copies can be moved to the Trash from Storage › Cleanup Review (after confirmation). Duplicates are never Attention items.

## WorkNEX & DevNEX integration

- **WorkNEX** provides contexts (title, time span, project, file names/paths it was allowed to see under its own per-app permissions). FileNEX uses them for *Recent work*, context collections, related files and ranking. A context’s files = files it saw (matched by path, or by name) + files changed in its project folder while it was active — only among already-indexed files.
- **DevNEX** provides projects (id, name, path). FileNEX shows project collections (files, recent files) for projects inside indexed folders; others are listed as *Not indexed — folder not added*.
- **MemNEX / system core**: memory pressure and CPU load slow down background indexing.

## Collections

Logical views — files are never moved. WorkNEX contexts and DevNEX projects appear automatically; you can create your own (*Q4 ISO29110*) and add files from a file’s page. Items survive *Rebuild* (file ids are stable path hashes).

## Storage Intelligence

**Know where your space went. Recover space without losing work. Analyze first. Delete deliberately.**

| Tab | Route | What it shows |
|---|---|---|
| Overview | `/filenex/storage` | Disk used/free, status, where the space went (approved folders, Docker, shared caches, *Not analyzed*), potentially recoverable, 7-day change, forecast |
| Large Files | `/filenex/storage/large-files` | Files > 100 MB / 500 MB / 1 GB / 5 GB, sorted by largest, oldest, newest, recently added, location · Open · Reveal · Details |
| Developer Storage | `/filenex/storage/developer[/:projectId]` | Repository ranking, per-repo breakdown, dependency footprint, build & cache, shared package caches, Docker, recent growth |
| Duplicates | `/filenex/storage/duplicates` | Exact duplicates ranked by space used by extra copies |
| Growth | `/filenex/storage/growth` | What grew (7/30 days), forecast, used space by day, repository growth |
| Cleanup Review | `/filenex/storage/cleanup[?project=]` | Candidates grouped by kind, with risk, reason, regeneratable, last used, project · **Preview** (exact paths, total, projects affected) |

### Same allowlist — no folder permission, no scanning

- **Disk capacity** comes from the OS (`statfs`) and needs no folder access; it is shown even with 0 folders.
- **Everything else** is measured only inside approved FileNEX locations. The size walk starts inside them, never follows symlinks, and re-checks every path against the allowlist. FileNEX pause, folder pause and removal stop it immediately (a partial walk is discarded).
- **DevNEX knows where the repo is; FileNEX still needs explicit permission to analyze it.** A DevNEX project outside the approved folders shows *Storage analysis unavailable — This repository is not included in FileNEX indexed locations* with an **Allow folder** button (pre-filled in the Add folder dialog). It is never scanned. Tested.
- Only sizes and dates are read (`lstat`), never contents. Names are recorded only for large files, known developer folders (node_modules, .next…), top-level folders and Downloads items — **never hidden or sensitive names** (`.env*`, credentials, keys…), which still count towards their parent's size.
- **Shared package caches** (npm `~/.npm/_cacache`, pnpm store, Yarn cache) are outside your folders, so they are measured only if you turn on *Shared developer caches* — total size only.
- **Docker**: `docker system df`. Per-project Docker size is an estimate by Compose project name. Docker's own cleanup (`docker builder prune -f`, `docker image prune -a -f`) runs only when you confirm it in Cleanup Review; volumes are never removed.

### Status (deterministic, configurable)

A level applies when free space is below `min(GB, % of disk)` — GB on large disks, a share of the disk on small ones:

| Status | Default | Also when |
|---|---|---|
| Critical | < 10 GB or 3 % | — |
| Low | < 25 GB or 8 % | the trend reaches the critical level within 2 weeks |
| Attention | < 50 GB or 15 % | the trend reaches the low level within 4 weeks |
| Healthy | otherwise | |

Settings › Status levels: Relaxed (25/15/5), Default (50/25/10), Cautious (100/50/20).

### History & forecast

`filenex_storage_snapshots` (about one per hour: total/used/free, plus category sizes after each analysis), `filenex_repo_storage_snapshots` (per repo after each analysis) and `filenex_storage_analysis` (latest analysis per approved folder) in `index.sqlite`. Retention 7/30/90/365 days (default 30). **What grew** compares used space with the snapshot nearest the window start and attributes the change to categories present in both snapshots; the rest is *Other — outside analyzed folders*. **Forecast** is a least-squares line over the last 28 days; it needs ≥ 4 snapshots over ≥ 3 days, otherwise *Not enough history to estimate.* Clearing storage history never touches a file.

### Dev Storage Map

DevNEX projects (boundaries, running services, Compose projects) + WorkNEX contexts (recent use) + FileNEX analyses → per-repository footprint:

| Category | Recognised folders | Default risk |
|---|---|---|
| Source | code, config, docs, lockfiles, `.env*` | Protected |
| Dependencies | `node_modules` · `.venv`/`venv` (Python) · `vendor` (PHP/Go/Ruby) | Review carefully — *regeneratable*, never “safe” |
| Build | `.next` · `.nuxt`/`.svelte-kit`/`.output` · `dist`/`build`/`out` · `target` (Rust/Java) · `bin`/`obj` (.NET) | Safe to review |
| Cache | `.turbo` · `.nx` · `.cache`/`.parcel-cache`/`.vite` · `coverage` · Python caches · `.gradle` | Safe to review |
| Logs | `logs`/`log` folders, `*.log` files | Safe to review if older than 7 days, else review carefully |
| Git | `.git` | Protected (visible, never suggested) |
| Other | assets, media, data | Protected |

Rules are data (`storage-engine/classify.ts`): a runtime is added by adding rows. Generic names (`dist`, `build`, `bin`, `target`…) count as build output only inside a project folder of a matching runtime (marker files: package.json, pyproject.toml, Cargo.toml, pom.xml, *.csproj, go.mod…) — a `build` folder in Documents is your work.

**Conservative recommendations**
- **Active project** (running services, WorkNEX activity, or source changed within 7 days): dependencies are *review carefully* and **not** counted as recoverable; build output of a project with running services is *review carefully*; caches stay reviewable. Never source or configuration.
- **Recently used today** (WorkNEX) → never counted as recoverable.
- **Inactive repository** (no activity for 90 days, configurable; 0 services): its regeneratable folders are suggested for review — the repository itself never is.
- **Git context, not permission**: a folder that contains Git-tracked files is Protected; one Git doesn't ignore is *review carefully* (untracked data can be important).
- Unregistered projects found in approved folders: dependencies are not counted as recoverable (activity unknown).

**Git worktrees** (a folder whose `.git` is a file — e.g. Claude Code agents in `.claude/worktrees/agent-…`, or `git worktree add`) are recognised during the walk and named by their **branch** (read-only `git branch`, `git log -1`, `git status --porcelain`). A worktree without uncommitted changes is **one** Cleanup row (*Git worktrees* group) — its node_modules/build output are inside it, not listed again — with *Copy command* `git worktree remove "<path>"` (the branch and its commits stay). It counts as recoverable only when nothing changed for 24 hours. A worktree with uncommitted changes (or unknown Git state) is never suggested; its folders stay individual. Repository detail lists worktrees (branch, size, dependencies, last commit, status).

**Readable names**: every candidate has a title relative to its worktree or project (`frontend/node_modules`) and a context line (`topo · worktree fix/cr-075-…`); long paths keep their start and end (`~/Documents/…/agent-a00dc…/frontend/node_modules`).

**No double counting**: hard links count once per walk; nested projects are inside their parent's total; shared stores are shown separately and never added to repo totals (pnpm `node_modules` may hard-link into the store); a shared cache inside an approved folder is moved out of that folder's figure; Docker data lives in Docker's own disk image and is not part of folder totals; recovery estimates count each path once.

### Cleanup — analyze first, delete deliberately

Candidates: developer build output, caches, dependencies, old logs, old downloads (> 90 days), large old archives/installers/disk images (> 180 days), exact duplicate copies, Docker unused images/build cache (volumes shown, not counted), shared caches. **Potentially recoverable** = the conservative sum (each byte once). Documents, photos, videos, `.env`, databases, source and Git are never candidates.

**Suggested plan** (top of Cleanup Review, and of the exported report; `GET /api/filenex/storage/cleanup-plan`): fixed rules — not AI — turn the candidates into ordered, explained steps: **1 · Build output** (regeneratable, most space, least risk; projects with running services and in-use worktrees are left out, with the reason) · **2 · node_modules of projects not touched for 60+ days** (projects in use listed under *Leave out*; the same project installed in several places is called out) · **3 · Check first** (worktrees by Git state, logs ≥ 50 MB, old archives) · **4 · Your call** (personal downloads, duplicates — with an effort-vs-gain note — small caches, Docker, shared caches). The headline states the disk situation and urgency. Steps 1–2 have *Select these* and *Clean up ~X…*; in step 3 an idle, clean worktree has its own *Remove…*; step 4 never bulk-selects. Step ids contain only items FileNEX can remove. Names are shown relative to the approved folder (`AppSightNEX-azure/web/.next`).

**Confirmed cleanup — nothing is ever removed automatically.** *Clean up…* (selection bar, a row, or a plan step) opens a preview of the exact paths, sizes and **how each item would be removed**:

| Item | How | Why |
|---|---|---|
| Build output, caches, dependencies (regeneratable) | **Deleted permanently** | Moving them to the Trash would free no space; re-created by building / reinstalling (the command is shown) |
| Old logs, old downloads, large old archives, duplicate copies | **Moved to the Trash** | Your files — restorable from the Trash |
| Clean, idle Git worktree | `git -C <main repo> worktree remove <path>` (never `--force`) | Keeps the branch and its commits; Git refuses on any change |
| Docker build cache / unused images · npm / pnpm / Yarn caches | The tool's own command (`docker builder prune -f`, `npm cache clean --force`…) | Never `rm` inside a tool's store |
| Docker volumes, protected items, items in use | **Not removed** — listed under *Not included* with the reason | Volumes can hold databases; active work is left alone |

Rules:
- **Off by default.** *Allow FileNEX to delete* (FileNEX › Settings › Storage, or *Allow deleting* in the preview) must be on.
- **Fresh confirmation.** The preview returns a one-time token valid for 5 minutes; anything marked *Review carefully* or more than 20 GB in total needs the typed word `delete`.
- **Re-checked right before removal.** Each item must still be suggested and removable, inside an active approved folder (never the folder itself, never a project root or a parent of one), not a symbolic link, unchanged since the preview (mtime / size), its project must have no running services, and a worktree must still be clean (Git state read again, uncached). Anything that fails is **skipped with the reason** — never removed on a stale confirmation.
- **Result**: removed / skipped / failed per item and the **measured** free-space change; items moved to the Trash still use space until you empty it. Kept in a local *Recent cleanups* history (`cleanup-history.json`, last 300). Changed folders are re-analyzed.
- **One entry point**: `StorageEngine.cleanupConfirm` → `storage-engine/executor.ts` is the only code in FileNEX that removes anything (a test enforces it). There is no *Clean everything* button.

### Performance

One folder at a time, throttled; known developer folders are measured as one unit and **reused** if their mtime is unchanged (re-measured at most daily); waits while the file index is scanning; **background analysis defers under high CPU (> 85 %) or memory pressure** (shared system monitor, as MemNEX) — *Storage analysis paused temporarily due to high system load*; manual *Analyze now* runs slower instead. File changes in a watched folder trigger a re-analysis at most every 30 minutes. Schedule: every 6 h / daily (default) / weekly / only when I ask. Progress shows items and *N / M repositories*.

### Workbench

- Module card: *Free space* and *Potential recovery*.
- Attention (only when it matters): **Disk space is low / critically low** → *Review Storage*; **Build output uses X GB** (≥ 10 GB recoverable) → *Review cleanup*; at most one **“<repo> grew by X GB this week”** (≥ 3 GB and ≥ 20 %) → *Review Developer Storage*.
- ⌘K: *Show storage*, *Show large files*, *Show developer storage*, *Review storage cleanup*, *What grew?*

### Storage API (`/api/filenex/storage/*`)

`GET status | overview | volumes | large-files?min&sort | growth?days=7|30 | developer?q&sort | developer/:projectId | cleanup-candidates | settings` ·
`GET cleanup-status | cleanup-history` · `POST cleanup-preview {ids} → {…, token} | cleanup-confirm {token, confirm?: "delete"} | open {path} | reveal {path} | scan {force?} | pause | resume` · `PUT settings` · `DELETE history?confirmed=true[&includeAnalyses=true]` (FileNEX history only).
Open/Reveal accept only paths FileNEX itself reported inside approved folders. Developer search: names or size filters — `node_modules > 5GB`, `build >= 500mb`, `total < 2gb`.

Storage limitations: Trash and folders outside the allowlist are not measured; macOS free space excludes purgeable space; APFS clones may be counted per copy; Docker per-project sizes are estimates; Windows is implemented (statfs per drive, `%LOCALAPPDATA%` caches) but not verified on a real machine.

## Local storage

`apps/workbench-api/.filenex/` (git-ignored):

| File | Contents |
|---|---|
| `settings.json` | Indexed locations (the allowlist), exclusions, indexing options |
| `scans.json` | Last scan time per location |
| `storage-settings.json`, `shared-caches.json` | Storage analysis settings; measured shared cache sizes (opt-in) |
| `index.sqlite` | `filenex_files`, `filenex_collections`, `filenex_collection_items`, `filenex_storage_snapshots`, `filenex_repo_storage_snapshots`, `filenex_storage_analysis` (Node’s built-in `node:sqlite`, no native dependency) |

- **Rebuild index**: deletes derived metadata and rescans approved folders; permissions, settings and collections stay.
- **Clear FileNEX index**: deletes FileNEX’s own metadata (optionally collections). **Your files are never deleted, moved or changed.**

Requires Node.js ≥ 22.13 (built-in SQLite without a flag). The “SQLite is experimental” warning is silenced in the npm scripts.

## API (`/api/filenex/*` via :3900)

`GET status | search?q&type&from&to&location&project&context | recent | recent-work | files/:id | files/:id/related | files/:id/versions | versions | duplicates | collections | collections/:id | locations | browse?path | settings` ·
`POST files/:id/open | files/:id/reveal | collections {name} | collections/:id/items {fileId} | locations {path, confirmBroad?} | locations/:id/scan | index/pause | index/resume | index/rebuild {confirmed}` ·
`PUT locations/:id {paused?, label?, excludedFolders?} | settings` ·
`DELETE collections/:id | collections/:id/items/:fileId | locations/:id?deleteIndex=true|false (choice required) | index?confirmed=true[&includeCollections=true]`

The file index endpoints never delete, move, rename or write user files. Storage cleanup removes only items you confirmed (see *Confirmed cleanup* above).

## Limitations

- Metadata only: no full-text or content search, no OCR (v1).
- Cloud folders (OneDrive, Google Drive, Dropbox) are indexed only as local files in a folder you add; FileNEX never talks to cloud services. “Files on demand” placeholders show as small files.
- Very large folders are capped at 250 000 files per location.
- Recursive watching is used on macOS and Windows; if watching fails, periodic scans still keep the index current.
- **Windows**: implemented (Explorer *Reveal*, default-app *Open*), not yet verified on a real machine.
- WorkNEX file association by name can match two different files with the same name; FileNEX prefers exact paths when WorkNEX has them.
