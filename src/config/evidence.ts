/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `npm run evidence` (scripts/generate-evidence.mjs) from vitest's own JSON
 * report, .github/workflows/ci.yml, and eslint.config.mjs. `npm run evidence:check`
 * fails if this file disagrees with those sources, and CI runs it on every push, so the
 * numbers the landing page prints about this project cannot silently go stale again.
 */

export interface EvidenceStat {
  readonly label: string
  readonly value: string
  readonly note: string
}

/** Test counts, straight from vitest's JSON reporter. */
export const TESTS = {
  passed: 497,
  skipped: 20,
  total: 517,
  files: 56,
} as const

/** Top-level jobs in .github/workflows/ci.yml. */
export const CI_JOBS = 6

/** Numbered `// BOUNDARY RULE n` blocks in eslint.config.mjs. */
export const BOUNDARY_RULES = 4

/**
 * The landing page's evidence tiles. Every count here is real and checkable by running
 * the command named beside it.
 */
export const EVIDENCE: readonly EvidenceStat[] = [
  { label: 'TypeScript tests, all green', value: '497', note: 'npm test, plus 20 needing DATABASE_URL' },
  { label: 'CI jobs, all green', value: '6', note: 'Linux, Windows, real Postgres' },
  { label: 'Secrets needed to run it', value: '0', note: 'empty .env' },
  { label: 'Boundary rules enforced', value: '4', note: 'plus a purity gate' },
] as const

/** Per-module test counts for day one's five modules, for the landing-page bar chart. */
export const TEST_SPREAD = [
  { module: 'money', n: 21 },
  { module: 'config', n: 20 },
  { module: 'rng', n: 18 },
  { module: 'json', n: 12 },
  { module: 'purity', n: 17 },
] as const

/** What TEST_SPREAD sums to — day one's modules only, not the whole suite. */
export const DAY_ONE_TESTS = 88
