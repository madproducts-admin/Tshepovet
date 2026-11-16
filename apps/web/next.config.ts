import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The TshepoVet web app. In production IIS sends /api, /v1, /webhooks, /healthz and /readyz to
 * the API and everything else here; the rewrites below do the same for `next dev` and are a
 * harmless fallback behind IIS.
 */
const api = process.env.TSV_API_ORIGIN ?? 'http://127.0.0.1:9131';

const config: NextConfig = {
  output: 'standalone',
  // npm workspaces: trace and compile from the repository root (the contracts are imported
  // from their TypeScript sources through the tsconfig path, never from a stale dist/).
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  turbopack: { root: path.join(__dirname, '..', '..') },
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/v1/:path*', destination: `${api}/v1/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default config;
