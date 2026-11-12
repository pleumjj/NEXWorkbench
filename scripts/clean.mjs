// Remove build output (dist, .next, tsbuildinfo). Never touches source or .memnex/.devnex data.
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
for (const group of ['packages', 'modules', 'apps']) {
  const dir = join(root, group);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    for (const out of ['dist', '.next', 'tsconfig.tsbuildinfo']) rmSync(join(dir, name, out), { recursive: true, force: true });
  }
}
console.log('Cleaned build output.');
