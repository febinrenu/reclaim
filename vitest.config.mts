import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  '~': fileURLToPath(new URL('./app', import.meta.url)),
}

export default defineConfig({
  test: {
    // Two projects with different contracts:
    //   unit        zero I/O, must stay fast enough to run on every save
    //   integration real Postgres (PGlite in memory, or DATABASE_URL), so it is slower
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts'],
          environment: 'node',
          // A unit test that takes longer than this is doing I/O it should not be doing.
          testTimeout: 5_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          // 120s, not 60s, and the extra headroom is for a real observed failure rather
          // than a precaution. Under heavy machine load (a full-suite run that took 591s
          // against its usual ~130s), repositories.test.ts failed with all 41 tests
          // skipped: its `beforeAll` does mkdtemp + spin up PGlite + apply 9 migrations,
          // which is comfortably under 60s idle and not under contention. It passes in
          // isolation and on every unloaded run, so the timeout was the binding
          // constraint, not the code. CI runners are slower than a dev machine, which is
          // exactly where this would bite. Deliberately generous rather than removed: a
          // hook that genuinely hangs should still fail the build, just not a slow one.
          hookTimeout: 120_000,
          // Each integration file gets its own database; running them in one process
          // keeps PGlite instances from competing for the same data directory.
          fileParallelism: false,
        },
      },
    ],
  },
})
