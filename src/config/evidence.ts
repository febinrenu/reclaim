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

/**
 * Test counts from vitest's JSON reporter — the two that are the same in every
 * environment. The passed/skipped split is deliberately NOT reported: two suites here
 * are credential-gated (node-pg needs DATABASE_URL, the live Groq test reads .env), so
 * that split differs between a machine with credentials and CI without them. `total`
 * and `files` are properties of the codebase. The generator refuses to run at all if
 * any test failed, so "zero failures" is a checked fact rather than a claim.
 */
export const TESTS = {
  total: 574,
  files: 62,
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
  { label: 'TypeScript tests, zero failures', value: '574', note: 'npm test, across 62 files' },
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
