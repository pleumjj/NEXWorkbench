// One-command install + launch for people who just want to use NEX Workbench.
//
//   npm run setup   → check Node, install dependencies, build, start, open the browser
//   npm run app     → start (building first only if there is no build yet) and open the browser
//
// Uses only Node built-ins so it works before `npm install`. Never touches local data (.nex, .memnex, …).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2] === 'setup' ? 'setup' : 'app';
const webPort = Number(process.env.NEX_WEB_PORT || 3900);
const url = `http://localhost:${webPort}`;
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';

const say = msg => console.log(`\x1b[36m[NEX]\x1b[0m ${msg}`);
const fail = msg => { console.error(`\x1b[31m[NEX]\x1b[0m ${msg}`); process.exit(1); };

// 1. Node version (node:sqlite needs ≥ 22.13).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(`NEX Workbench needs Node.js 22.13 or newer — this is ${process.version}.\n      Install the LTS from https://nodejs.org and run this again.`);
}

// 2. Already running? Just open it.
if (await isUp()) {
  say(`NEX Workbench is already running → ${url}`);
  openBrowser();
  process.exit(0);
}

// 3. Install + build.
const builtWeb = existsSync(join(root, 'apps/workbench-web/.next/BUILD_ID'));
const builtApi = existsSync(join(root, 'apps/workbench-api/dist/main.js'));
const installed = existsSync(join(root, 'node_modules/.package-lock.json'));
if (mode === 'setup' || !installed) {
  say('Installing dependencies (first time takes a few minutes)…');
  run(npm, ['install', '--no-fund', '--no-audit']);
}
if (mode === 'setup' || !builtWeb || !builtApi) {
  say('Building…');
  run(npm, ['run', 'build']);
}

// 4. Start, open the browser when it answers, stop cleanly on Ctrl+C.
say('Starting NEX Workbench… (press Ctrl+C to stop)');
const child = spawn(npm, ['start'], { cwd: root, stdio: 'inherit', shell: win });
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 500));
  if (await isUp()) {
    say(`Ready → ${url}`);
    openBrowser();
    break;
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: win });
  if (r.status !== 0) fail(`"${cmd} ${args.join(' ')}" failed. Scroll up for the error.`);
}

async function isUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${webPort}/api/workbench/summary`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function openBrowser() {
  if (process.env.NEX_NO_OPEN) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : win ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed above */ }
}
