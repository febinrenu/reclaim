import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // PGlite ships a WebAssembly Postgres build. Turbopack must not try to bundle it
  // into the server chunk, and `pg` has native-ish resolution that bundling breaks.
  // Without this the embedded database fails to initialise at runtime.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],

  // Surface type errors at build time. This defaults to blocking; stating it
  // explicitly documents that we did not switch it off when it got inconvenient.
  // Note: Next 16 removed the `eslint` config key along with `next lint`, so
  // linting runs as its own CI step via `npm run lint`.
  typescript: { ignoreBuildErrors: false },
}

export default nextConfig
