# Language (English / ไทย)

NEX Workbench shows its UI in **English** or **Thai**.

- **Workbench › Settings › Language**: *Follow system* (default), *English*, or *ไทย*.
  *Follow system* reads the operating system’s preferred language (macOS: the first entry of `AppleLanguages`;
  Windows/Linux: the user locale) via `GET /api/system/locale`. `en-TH` → English, `th-TH` → Thai.
- Dates use the **Gregorian calendar** (2026) and Latin digits in both languages.
- **Always English**: reports exported for Claude (Cleanup Review › Export for Claude) and timesheet CSV files.

## How it works

`packages/i18n` (`@nex/i18n`, consumed as source by the web app):

| Piece | Role |
|---|---|
| `src/index.ts` | `translate()`, language state, Gregorian/Latin-digit formatters (`localeTag`, `fmtDate`…) |
| `src/jsx-runtime.ts` | The web app’s JSX runtime (`jsxImportSource` in `apps/workbench-web/tsconfig.json`; `/** @jsxImportSource @nex/i18n */` in `packages/ui`). In Thai, string children and `title` / `placeholder` / `aria-label` / `alt` of elements pass through `translate()`. |
| `src/th/*.ts` | Thai dictionary: English source text → Thai, one file per area; `extra.ts` is loaded last and holds final choices. |

English is the source language: UI code and engine messages are written in English and stay that way (so exports
and logs are English). Lookup order: exact phrase → pattern (`{n}` = a value starting with a digit-bearing token,
`{s}` = any text; Thai values may reorder with `{0}`, `{1}`) → the phrase without leading/trailing separators
(`· `, ` —`) → parts of a composite message split on ` · `, ` — ` and sentence ends. Anything unknown stays English.

**User data is never translated**: file, folder, project, app and branch names are rendered inside `translate="no"`,
`.mono`, `.path`, `<code>` or `<kbd>`. Patterns with fewer than 3 letters of real text are ignored so they cannot
rewrite arbitrary text.

## Adding or changing text

1. Write the English UI text as usual.
2. Add the Thai entry to the matching `packages/i18n/src/th/<area>.ts` (or `extra.ts`). Use `{n}` / `{s}` for values.
3. Check coverage in the browser with the UI in Thai: `window.__nexI18nMissing` lists strings shown without a
   translation (data such as file names is expected there). `node scripts/i18n-extract.mjs` lists source strings.
4. `npm test` checks that every Thai value uses the placeholders of its key.

After changing `jsxImportSource`, delete `apps/workbench-web/.next` once — Next.js caches compiled files.

Thai font: IBM Plex Sans Thai (Thai glyphs only, SIL OFL — `apps/workbench-web/app/fonts/IBMPlexSansThai-OFL.txt`),
bundled locally like the Latin font. `:lang(th)` rules in `packages/ui/src/styles.css` remove negative letter-spacing
and raise line height so vowels and tone marks are never clipped.
