import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { JsonFile } from '@nex/config';

export type RegistryState = { roots: string[]; projects: string[]; hidden: string[] };

/** Which folders DevNEX watches — a small JSON file of paths (no database). */
export class ProjectRegistry {
  private readonly file: JsonFile<RegistryState>;
  constructor(path: string) {
    this.file = new JsonFile(path, () => ({ roots: [], projects: [], hidden: [] }), (raw: any) => ({
      roots: Array.isArray(raw?.roots) ? raw.roots.filter((x: unknown) => typeof x === 'string') : [],
      projects: Array.isArray(raw?.projects) ? raw.projects.filter((x: unknown) => typeof x === 'string') : [],
      hidden: Array.isArray(raw?.hidden) ? raw.hidden.filter((x: unknown) => typeof x === 'string') : [],
    }));
  }
  get() { return this.file.get(); }

  /** Only real directories inside the user's home folder can be registered. */
  static validate(path: string, home = homedir()): string {
    const p = resolve(String(path ?? '').replace(/^~(?=$|\/|\\)/, home));
    if (!p.startsWith(home + sep)) throw new Error('Choose a folder inside your home directory.');
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error('That folder does not exist.');
    return p;
  }
  addProject(path: string) { const p = ProjectRegistry.validate(path); return this.file.update(s => ({ ...s, projects: [...new Set([...s.projects, p])], hidden: s.hidden.filter(h => h !== p) })); }
  addRoot(path: string) { const p = ProjectRegistry.validate(path); return this.file.update(s => ({ ...s, roots: [...new Set([...s.roots, p])] })); }
  remove(raw: string) {
    const path = resolve(String(raw ?? '').replace(/^~(?=$|\/|\\)/, homedir()));
    return this.file.update(s => ({ roots: s.roots.filter(r => r !== path), projects: s.projects.filter(r => r !== path), hidden: [...new Set([...s.hidden, path])] }));
  }
}
