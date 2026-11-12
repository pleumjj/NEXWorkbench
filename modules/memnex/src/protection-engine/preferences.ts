import { JsonFile } from '@nex/config';
import type { Preferences } from '../types';

/** After this many times the user keeps a suggested app open, MemNEX stops suggesting it. */
export const KEPT_OPEN_LIMIT = 3;

const normalize = (raw: any): Preferences => ({
  protectedApps: Array.isArray(raw?.protectedApps) ? raw.protectedApps.filter((x: unknown) => typeof x === 'string') : [],
  keptOpen: raw?.keptOpen && typeof raw.keptOpen === 'object' ? raw.keptOpen : {},
});

/** User preferences only — a small JSON file (not a database), loaded once and written through. */
export class PreferenceStore {
  private readonly file: JsonFile<Preferences>;
  constructor(path: string) { this.file = new JsonFile(path, () => ({ protectedApps: [], keptOpen: {} }), normalize); }

  get() { return this.file.get(); }
  isProtected(name: string) { return this.get().protectedApps.includes(name.toLowerCase()); }
  setProtected(name: string, value: boolean) {
    return this.file.update(s => {
      const set = new Set(s.protectedApps);
      value ? set.add(name.toLowerCase()) : set.delete(name.toLowerCase());
      return { ...s, protectedApps: [...set] };
    });
  }
  /** Learn from a cleanup: unchecked suggestions count up, chosen ones reset. */
  learn(kept: string[], closed: string[]) {
    return this.file.update(s => {
      const keptOpen = { ...s.keptOpen };
      for (const n of kept) keptOpen[n.toLowerCase()] = (keptOpen[n.toLowerCase()] ?? 0) + 1;
      for (const n of closed) delete keptOpen[n.toLowerCase()];
      return { ...s, keptOpen };
    });
  }
  isMuted(name: string) { return (this.get().keptOpen[name.toLowerCase()] ?? 0) >= KEPT_OPEN_LIMIT; }
  /** "Suggest again". */
  unmute(name: string) {
    return this.file.update(s => { const keptOpen = { ...s.keptOpen }; delete keptOpen[name.toLowerCase()]; return { ...s, keptOpen }; });
  }
}
