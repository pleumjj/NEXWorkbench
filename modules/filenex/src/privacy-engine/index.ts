import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import type { FilenexSettings, IndexedLocation } from '../types';

/**
 * FileNEX privacy boundary.
 *
 *   No folder permission, no indexing.
 *
 * Discovery itself only walks approved locations; every path is still checked here before it can become a record.
 * Registering a project in DevNEX, or a file appearing in WorkNEX, never grants permission.
 */

export const DEFAULT_IGNORED_FOLDERS = [
  'node_modules', '.git', '.svn', '.hg', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', 'dist', 'build', 'out', 'coverage',
  'tmp', 'temp', 'cache', '__pycache__', '.venv', 'venv', 'target', '.gradle', '.idea', 'Pods', 'DerivedData', '.terraform',
];
export const DEFAULT_IGNORED_EXTENSIONS = ['log', 'tmp', 'temp', 'swp', 'swo', 'bak~', 'crdownload', 'part', 'lock', 'pyc', 'class', 'o', 'obj'];

export const DEFAULT_SETTINGS: FilenexSettings = {
  locations: [],
  paused: false,
  scanEveryMinutes: 60,
  deferUnderPressure: true,
  watchChanges: true,
  ignoredFolders: DEFAULT_IGNORED_FOLDERS,
  ignoredExtensions: DEFAULT_IGNORED_EXTENSIONS,
  excludeSensitive: true,
  includeHidden: false,
};

/**
 * Names that usually hold secrets. Their metadata is not indexed by default (contents never are).
 * `.key` is deliberately not on the list — on macOS it is a Keynote presentation.
 */
const SENSITIVE_NAME = /(^\.env(\..*)?$|(^|[._\-\s])(secrets?|credentials?|passwords?|passwd|private[_\-\s]?key|privkey|id_rsa|id_ed25519|id_ecdsa|token)([._\-\s]|$))/i;
const SENSITIVE_EXT = /\.(pem|p12|pfx|kdbx|keychain|keychain-db|asc|gpg|ovpn|ppk|jks|keystore)$/i;
export const isSensitiveName = (name: string) => SENSITIVE_NAME.test(name) || SENSITIVE_EXT.test(name);

/** Packages that look like folders but are one document (macOS). Indexed as a single file, never walked. */
export const DOCUMENT_PACKAGE = /\.(pages|numbers|key|rtfd|graffle|sketch|scriv|band|logicx|fcpbundle|xcodeproj|xcworkspace)$/i;
/** App/system bundles: skipped entirely. */
export const SKIP_PACKAGE = /\.(app|framework|bundle|plugin|kext|photoslibrary|musiclibrary|tvlibrary|imovielibrary|lrlibrary)$/i;

/** Resolved path without a trailing separator — but the root itself stays "/" (never an empty string). */
const norm = (p: string) => { const r = resolve(p); const t = r.replace(/[\\/]+$/, ''); return t || r; };
const cmp = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? norm(p).toLowerCase() : norm(p));

/** Inside (or equal to) a folder — by path segments, so /Docs/Projects2 is not inside /Docs/Projects. */
export function isInside(path: string, folder: string): boolean {
  const p = cmp(path), f = cmp(folder);
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep);
}

/** The single authorization check: the active (not paused) location that covers this path, or null. */
export function approvedLocationFor(path: string, s: Pick<FilenexSettings, 'locations'>, opts: { includePaused?: boolean } = {}): IndexedLocation | null {
  if (!path || !isAbsolute(path)) return null;
  const hits = s.locations.filter(l => (opts.includePaused || !l.paused) && isInside(path, l.path));
  return hits.sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/** Folders that are never accepted as a location (the OS itself, the whole disk). */
const FORBIDDEN = [/^\/$/, /^\/(System|Library|usr|bin|sbin|etc|var|private|dev|opt|cores)(\/|$)/i, /^[a-z]:\\?$/i, /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)(\\|$)/i];
export function validateLocationPath(raw: string, home: string, exists: (p: string) => boolean): string {
  const expanded = String(raw ?? '').trim().replace(/^~(?=$|[\\/])/, home);
  if (!expanded || !isAbsolute(expanded)) throw new Error('Enter a full folder path, e.g. ~/Documents/Projects.');
  const p = norm(expanded);
  if (FORBIDDEN.some(re => re.test(p))) throw new Error('System folders and whole drives cannot be indexed. Choose a work folder.');
  if (!exists(p)) throw new Error('That folder does not exist (or is not a folder).');
  return p;
}

/** Folders broad enough that the UI should ask twice (home, Desktop, Downloads, Documents themselves). */
export const isBroadFolder = (p: string, home: string) => [home, `${home}/Desktop`, `${home}/Downloads`, `${home}/Documents`].map(norm).includes(norm(p));

export const locationId = (path: string) => createHash('sha1').update(cmp(path)).digest('hex').slice(0, 10);

/** Should a directory be walked? */
export function allowDir(name: string, s: Pick<FilenexSettings, 'ignoredFolders' | 'includeHidden'>, extra: string[] = []): boolean {
  if (!s.includeHidden && name.startsWith('.')) return false;
  if (SKIP_PACKAGE.test(name)) return false;
  const ignored = new Set([...s.ignoredFolders, ...extra].map(x => x.toLowerCase()));
  return !ignored.has(name.toLowerCase());
}

/** Should a file become a record? (Name-level rules; the location check is separate and always first.) */
export function allowFile(name: string, s: Pick<FilenexSettings, 'ignoredExtensions' | 'excludeSensitive' | 'includeHidden'>): boolean {
  if (!s.includeHidden && name.startsWith('.')) return false;
  if (name.startsWith('~$') || name === 'Thumbs.db' || name === 'desktop.ini' || name === 'Icon\r') return false;
  if (s.excludeSensitive && isSensitiveName(name)) return false;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return !s.ignoredExtensions.map(x => x.toLowerCase().replace(/^\*?\./, '')).includes(ext);
}

const strList = (v: unknown, fallback: string[], max = 200) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))].slice(0, max) : fallback;

export function normalizeSettings(raw: unknown, base: FilenexSettings = DEFAULT_SETTINGS): FilenexSettings {
  const r = (raw ?? {}) as Partial<Record<keyof FilenexSettings, unknown>>;
  const bool = (k: keyof FilenexSettings) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (base[k] as boolean));
  const every = Number(r.scanEveryMinutes);
  const locations = Array.isArray(r.locations)
    ? (r.locations as Partial<IndexedLocation>[]).filter(l => l && typeof l.path === 'string' && isAbsolute(l.path)).map(l => ({
        id: locationId(l.path!), path: norm(l.path!), label: typeof l.label === 'string' && l.label ? l.label.slice(0, 80) : basename(l.path!),
        paused: l.paused === true, addedAt: typeof l.addedAt === 'string' ? l.addedAt : new Date(0).toISOString(),
        excludedFolders: strList(l.excludedFolders, []),
      })).filter((l, i, all) => all.findIndex(x => x.id === l.id) === i)
    : base.locations;
  return {
    locations,
    paused: bool('paused'),
    scanEveryMinutes: [0, 15, 60, 360, 1440].includes(every) ? every : base.scanEveryMinutes,
    deferUnderPressure: bool('deferUnderPressure'),
    watchChanges: bool('watchChanges'),
    ignoredFolders: strList(r.ignoredFolders, base.ignoredFolders),
    ignoredExtensions: strList(r.ignoredExtensions, base.ignoredExtensions),
    excludeSensitive: bool('excludeSensitive'),
    includeHidden: bool('includeHidden'),
  };
}
