import type { CleanupRisk, Runtime, StorageCategory, StorageEntry, StorageSettings } from '../storage-types';
import { isSensitiveName } from '../privacy-engine';

/**
 * Developer storage classification. Each rule names a folder FileNEX measures as one unit.
 * Rules are data, so a runtime (Python, Java, .NET, Go, Rust…) is added by adding rows — the engine does not change.
 *
 * `needs`: generic names (dist, build, bin, target…) are only developer artifacts inside a project folder of a matching
 * runtime — a "build" folder in Documents may be someone's work.
 */
export interface ArtifactRule {
  id: string;
  names: string[];
  category: StorageCategory;
  runtime: Runtime;
  regeneratable: boolean;
  /** Runtimes whose project marker must be present in an ancestor folder; [] = any project; null = anywhere. */
  needs: Runtime[] | [] | null;
  label: string;
  explanation: string;
  regenerate?: string;
}

export const ARTIFACT_RULES: ArtifactRule[] = [
  // Dependencies — regeneratable, but deleting them interrupts development until reinstalled.
  { id: 'node_modules', names: ['node_modules'], category: 'dependencies', runtime: 'node', regeneratable: true, needs: null, label: 'node_modules', explanation: 'Installed npm packages. Re-created by installing dependencies.', regenerate: 'npm install (or pnpm install / yarn)' },
  { id: 'python-venv', names: ['.venv', 'venv'], category: 'dependencies', runtime: 'python', regeneratable: true, needs: ['python'], label: 'Python virtualenv', explanation: 'A Python virtual environment with installed packages.', regenerate: 'python -m venv .venv && pip install -r requirements.txt' },
  { id: 'vendor', names: ['vendor'], category: 'dependencies', runtime: 'php', regeneratable: false, needs: ['php', 'go', 'ruby'], label: 'vendor', explanation: 'Vendored dependencies. Sometimes committed on purpose — check before removing.' },
  // Build output — regeneratable by building again.
  { id: 'next', names: ['.next'], category: 'build', runtime: 'node', regeneratable: true, needs: null, label: '.next', explanation: 'Next.js build output and its build cache. Re-created by the next build or dev run.', regenerate: 'next build / next dev' },
  { id: 'nuxt', names: ['.nuxt', '.svelte-kit', '.output', '.docusaurus', '.expo'], category: 'build', runtime: 'node', regeneratable: true, needs: [], label: 'Framework build output', explanation: 'Generated framework output. Re-created on the next build.', regenerate: 'run the project’s build' },
  { id: 'dist', names: ['dist', 'build', 'out'], category: 'build', runtime: 'generic', regeneratable: true, needs: [], label: 'dist / build / out', explanation: 'Compiled or bundled output. Re-created by building the project.', regenerate: 'run the project’s build' },
  { id: 'target', names: ['target'], category: 'build', runtime: 'rust', regeneratable: true, needs: ['rust', 'java'], label: 'target', explanation: 'Cargo / Maven build output. Re-created by building.', regenerate: 'cargo build / mvn package' },
  { id: 'dotnet', names: ['bin', 'obj'], category: 'build', runtime: 'dotnet', regeneratable: true, needs: ['dotnet'], label: 'bin / obj', explanation: '.NET build output. Re-created by dotnet build.', regenerate: 'dotnet build' },
  // Caches — regeneratable, usually the safest to review.
  { id: 'turbo', names: ['.turbo'], category: 'cache', runtime: 'node', regeneratable: true, needs: null, label: 'Turbo cache', explanation: 'Turborepo task cache. Rebuilt automatically.' },
  { id: 'nx', names: ['.nx'], category: 'cache', runtime: 'node', regeneratable: true, needs: null, label: 'Nx cache', explanation: 'Nx computation cache. Rebuilt automatically.' },
  { id: 'tool-cache', names: ['.cache', '.parcel-cache', '.angular', '.eslintcache', '.vite', '.webpack-cache'], category: 'cache', runtime: 'node', regeneratable: true, needs: [], label: 'Tool cache', explanation: 'Bundler / tool cache. Rebuilt automatically.' },
  { id: 'coverage', names: ['coverage', '.nyc_output'], category: 'cache', runtime: 'generic', regeneratable: true, needs: [], label: 'Coverage', explanation: 'Test coverage reports. Re-created by running tests with coverage.' },
  { id: 'python-cache', names: ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'], category: 'cache', runtime: 'python', regeneratable: true, needs: null, label: 'Python caches', explanation: 'Bytecode and tool caches. Rebuilt automatically.' },
  { id: 'gradle', names: ['.gradle'], category: 'cache', runtime: 'java', regeneratable: true, needs: null, label: 'Gradle cache', explanation: 'Gradle project cache. Rebuilt automatically.' },
  // Logs — records, not regeneratable; old ones are worth reviewing.
  { id: 'logs', names: ['logs', 'log'], category: 'logs', runtime: 'generic', regeneratable: false, needs: [], label: 'Logs', explanation: 'Log files written by the project or its tools.' },
  // Git — visible, never recommended for deletion.
  { id: 'git', names: ['.git'], category: 'git', runtime: 'generic', regeneratable: false, needs: null, label: '.git', explanation: 'The repository’s history. Never suggested for cleanup.' },
];

/** Project markers: a folder containing one of these is a project root of that runtime. */
const MARKERS: [RegExp, Runtime][] = [
  [/^(package\.json|pnpm-workspace\.yaml|deno\.json)$/i, 'node'],
  [/^(pyproject\.toml|requirements\.txt|setup\.py|pipfile)$/i, 'python'],
  [/^cargo\.toml$/i, 'rust'],
  [/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/i, 'java'],
  [/\.(csproj|fsproj|vbproj|sln)$/i, 'dotnet'],
  [/^go\.mod$/i, 'go'],
  [/^composer\.json$/i, 'php'],
  [/^gemfile$/i, 'ruby'],
];
export function markersIn(names: string[]): Runtime[] {
  const out = new Set<Runtime>();
  for (const n of names) for (const [re, rt] of MARKERS) if (re.test(n)) out.add(rt);
  return [...out];
}

/**
 * Is this folder a known developer artifact? `runtimes` = runtimes of the nearest project root above it (empty when
 * the folder is not inside any project). Disabled detection settings turn rule groups off.
 */
export function classifyDir(name: string, runtimes: Runtime[], s: Pick<StorageSettings, 'detectDependencies' | 'detectBuildArtifacts'> = { detectDependencies: true, detectBuildArtifacts: true }): ArtifactRule | null {
  const lower = name.toLowerCase();
  const rule = ARTIFACT_RULES.find(r => r.names.some(n => n.toLowerCase() === lower));
  if (!rule) return null;
  if (rule.category === 'dependencies' && !s.detectDependencies) return null;
  if ((rule.category === 'build' || rule.category === 'cache') && !s.detectBuildArtifacts) return null;
  if (rule.needs === null) return rule;
  if (!runtimes.length) return null;
  if (rule.needs.length && !rule.needs.some(r => runtimes.includes(r))) return null;
  return rule;
}
export const ruleById = (id: string) => ARTIFACT_RULES.find(r => r.id === id) ?? null;

/** Source-like files inside a project (code, config, docs). Everything else non-artifact is "other". */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|java|kt|kts|go|rs|c|cc|cpp|h|hpp|cs|fs|vb|rb|php|swift|scala|dart|lua|r|sh|zsh|bash|ps1|bat|css|scss|sass|less|html|htm|vue|svelte|astro|json|jsonc|json5|yaml|yml|toml|ini|xml|md|mdx|markdown|rst|txt|sql|graphql|gql|proto|prisma|tf|hcl|lock|gradle|properties|editorconfig|gitignore|gitattributes|npmrc|nvmrc|env\.example)$/i;
const SOURCE_NAME = /^(dockerfile|makefile|procfile|readme|license|changelog|\.[a-z]+rc|\.gitignore|\.dockerignore|\.editorconfig)$/i;
export const isSourceFile = (name: string) => SOURCE_EXT.test(name) || SOURCE_NAME.test(name);
/** Never offered for cleanup, whatever their size: secrets and local databases. */
export const isProtectedFile = (name: string) => isSensitiveName(name) || /\.(sqlite3?|db|mdb|accdb|realm)$/i.test(name);

export type RiskContext = {
  /** DevNEX/WorkNEX say the project is in active use (running services, or used in the last days). */
  active: boolean;
  runningServices: number;
  /** Git context: ignored / tracked / untracked — context only, never permission. */
  git?: 'ignored' | 'tracked' | 'untracked' | null;
  /** Newest modification of the thing (logs: how recent). */
  modifiedAt?: string | null;
  now: number;
};

/**
 * Deterministic cleanup risk. Never "safe to delete" — at most "safe to review".
 *   PROTECTED          source, .git, files tracked by Git, secrets, databases (never suggested)
 *   REVIEW_CAREFULLY   dependencies, vendor, recent logs, build output a running service may use, anything Git doesn't ignore
 *   SAFE_TO_REVIEW     caches, build output of idle projects, old logs
 */
export function assessRisk(category: StorageCategory, rule: ArtifactRule | null, ctx: RiskContext): { risk: CleanupRisk; recoverable: boolean; reason: string } {
  if (category === 'git') return { risk: 'PROTECTED', recoverable: false, reason: 'Repository history — never suggested for cleanup.' };
  if (category === 'source' || category === 'other') return { risk: 'PROTECTED', recoverable: false, reason: category === 'source' ? 'Source code and configuration.' : 'Project files that are not known build output.' };
  if (ctx.git === 'tracked') return { risk: 'PROTECTED', recoverable: false, reason: 'Contains files tracked by Git — part of the project, not build output.' };
  const ageDays = ctx.modifiedAt ? (ctx.now - Date.parse(ctx.modifiedAt)) / 86_400_000 : null;
  if (category === 'dependencies') {
    if (!rule?.regeneratable) return { risk: 'REVIEW_CAREFULLY', recoverable: false, reason: 'Vendored dependencies — may be committed on purpose.' };
    return ctx.active
      ? { risk: 'REVIEW_CAREFULLY', recoverable: false, reason: 'Regeneratable, but this project is active — removing dependencies would interrupt work until you reinstall.' }
      : { risk: 'REVIEW_CAREFULLY', recoverable: true, reason: 'Regeneratable by reinstalling. The project has not been active recently.' };
  }
  if (category === 'logs') {
    return ageDays != null && ageDays > 7
      ? { risk: 'SAFE_TO_REVIEW', recoverable: true, reason: `Logs, last written ${Math.floor(ageDays)} days ago.` }
      : { risk: 'REVIEW_CAREFULLY', recoverable: false, reason: 'Recent logs — may be needed to investigate a problem.' };
  }
  // build / cache
  const untracked = ctx.git === 'untracked';
  if (category === 'build' && ctx.runningServices > 0) return { risk: 'REVIEW_CAREFULLY', recoverable: false, reason: 'Build output of a project with running services — a service may be using it.' };
  if (untracked) return { risk: 'REVIEW_CAREFULLY', recoverable: true, reason: 'Looks like generated output, but Git does not ignore it — it may be intentional.' };
  return { risk: 'SAFE_TO_REVIEW', recoverable: true, reason: category === 'cache' ? 'Cache — rebuilt automatically when needed.' : 'Build output — re-created by building the project.' };
}

export const riskOrder: Record<CleanupRisk, number> = { SAFE_TO_REVIEW: 0, REVIEW_CAREFULLY: 1, PROTECTED: 2 };
export const sumBytes = (xs: Pick<StorageEntry, 'bytes'>[]) => xs.reduce((n, x) => n + x.bytes, 0);
