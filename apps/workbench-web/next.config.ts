import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { PORTS } from '@nex/config';

/**
 * One user-facing origin: http://localhost:3900.
 * Every /api/* call is proxied to the loopback-only Workbench API, so the browser never talks to another port.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the dev overlay badge out of the sidebar footer.
  devIndicators: false,
  // The npm workspace root (not a lockfile elsewhere on the machine).
  outputFileTracingRoot: resolve(process.cwd(), '..', '..'),
  // SSE (live logs, events) must not be gzip-buffered by the dev proxy.
  compress: false,
  // The shared design system is consumed as TypeScript source.
  transpilePackages: ['@nex/ui'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `http://127.0.0.1:${PORTS.api}/:path*` }];
  },
};
export default nextConfig;
