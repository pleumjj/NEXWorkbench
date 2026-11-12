// Run `next dev|start` for the Workbench web app on its port (3900), bound to loopback only.
// Usage (from apps/workbench-web): node ../../scripts/next.mjs dev
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const [command = 'dev'] = process.argv.slice(2);
const port = String(process.env.NEX_WEB_PORT || 3900);
// The web server proxies to a process-control API, so it must not listen on the LAN by default.
const host = process.env.NEX_WEB_HOST || '127.0.0.1';

const require = createRequire(`${process.cwd()}/package.json`);
const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, command, '-p', port, '-H', host], { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
child.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
