/**
 * Generates `src/config/evidence.ts` — the counts the landing page prints about this
 * project itself.
 *
 * Why this exists: the landing page used to hand-type those numbers, and they went
 * stale (it claimed 423 tests against an actual 463, and 5 CI jobs against an actual
 * 6). A submission whose whole argument is "every number here is checkable" cannot
 * afford a wrong number on its own front page, so the numbers are now derived from the
 * artifacts that define them, and the derivation is checked in CI:
 *
 *   npm run evidence          regenerate src/config/evidence.ts
 *   npm run evidence:check    fail if the committed file disagrees with the sources
 *
 * Sources, each the real thing rather than a second copy of it:
 *   - test counts        vitest's own JSON reporter (`--reporter=json`)
 *   - CI job count       the top-level keys under `jobs:` in .github/workflows/ci.yml
 *   - boundary rules     the numbered `// BOUNDARY RULE n` blocks in eslint.config.mjs
 *   - day-one modules    per-file assertion counts from the same vitest report
 *
 * Usage:
 *   node scripts/generate-evidence.mjs [--report <vitest.json>] [--check]
 *
 * With no --report it runs the suite itself. CI passes --report so the suite is not run
 * twice: the `verify` job already emits the JSON alongside its normal output.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'src', 'config', 'evidence.ts')

/**
 * The five modules day one shipped, in the order the landing-page chart draws them:
 * `[chart label, test file basename]`. The label and the filename are not always the
 * same — the JSON firewall's suite is `json-firewall.test.ts` but the chart has room
 * for `json` — so the mapping is written out rather than guessed at.
 */
const DAY_ONE_MODULES = [
  ['money', 'money.test.ts'],
  ['config', 'config.test.ts'],
  ['rng', 'rng.test.ts'],
  ['json', 'json-firewall.test.ts'],
  ['purity', 'purity.test.ts'],
]

function parseArgs(argv) {
  const args = { report: null, check: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true
    else if (argv[i] === '--report') args.report = argv[++i] ?? null
  }
  return args
}

/** Runs the suite and returns the path to its JSON report. */
function runSuite() {
  const out = join(mkdtempSync(join(tmpdir(), 'reclaim-evidence-')), 'vitest.json')
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vitest', 'run', '--reporter=json', '--outputFile=' + out.split('\\').join('/')],
    { cwd: ROOT, stdio: 'inherit' },
  )
  return out
}

function readTestCounts(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const byModule = new Map()
  for (const file of report.testResults ?? []) {
    // `name` is an absolute path with forward slashes on every platform vitest
    // supports; key on the basename so the map is keyed the way DAY_ONE_MODULES is.
    const key = basename(file.name)
    byModule.set(key, (byModule.get(key) ?? 0) + file.assertionResults.length)
  }
  return {
    passed: report.numPassedTests,
    skipped: report.numPendingTests,
    total: report.numTotalTests,
    files: report.testResults?.length ?? 0,
    byModule,
  }
}

/**
 * Counts the top-level jobs in the CI workflow: the two-space-indented keys inside the
 * `jobs:` block. Deliberately a line scan rather than a YAML dependency — the shape
 * being counted is one level deep, and adding a parser dependency for it would be the
 * more fragile choice, not the less.
 */
function countCiJobs(yaml) {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (start === -1) throw new Error('ci.yml: no top-level `jobs:` key found')
  let count = 0
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // a new top-level key ends the jobs block
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) count++
  }
  if (count === 0) throw new Error('ci.yml: `jobs:` block parsed as empty')
  return count
}

function countBoundaryRules(eslintConfig) {
  const matches = eslintConfig.match(/^\s*\/\/ BOUNDARY RULE \d+/gm) ?? []
  if (matches.length === 0) {
    throw new Error('eslint.config.mjs: no `// BOUNDARY RULE n` blocks found')
  }
  return matches.length
}

function render({ tests, ciJobs, boundaryRules }) {
  const spread = DAY_ONE_MODULES.map(([label, file]) => {
    const n = tests.byModule.get(file)
    if (n === undefined) {
      throw new Error(
        'No test file named ' +
          file +
          ' in the vitest report. Either the suite was renamed, or DAY_ONE_MODULES in ' +
          'scripts/generate-evidence.mjs is stale.',
      )
    }
    return { module: label, n }
  })
  const dayOneTotal = spread.reduce((sum, s) => sum + s.n, 0)

  // Built here rather than interpolated inside the template below, so the generated
  // file never carries a nested template literal that has to be escaped.
  const testsNote =
    tests.skipped > 0
      ? 'npm test, plus ' + tests.skipped + ' needing DATABASE_URL'
      : 'npm test'

  const spreadRows = spread
    .map((s) => "  { module: '" + s.module + "', n: " + s.n + ' },')
    .join('\n')

  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by \`npm run evidence\` (scripts/generate-evidence.mjs) from vitest's own JSON
 * report, .github/workflows/ci.yml, and eslint.config.mjs. \`npm run evidence:check\`
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
  passed: ${tests.passed},
  skipped: ${tests.skipped},
  total: ${tests.total},
  files: ${tests.files},
} as const

/** Top-level jobs in .github/workflows/ci.yml. */
export const CI_JOBS = ${ciJobs}

/** Numbered \`// BOUNDARY RULE n\` blocks in eslint.config.mjs. */
export const BOUNDARY_RULES = ${boundaryRules}

/**
 * The landing page's evidence tiles. Every count here is real and checkable by running
 * the command named beside it.
 */
export const EVIDENCE: readonly EvidenceStat[] = [
  { label: 'TypeScript tests, all green', value: '${tests.passed}', note: '${testsNote}' },
  { label: 'CI jobs, all green', value: '${ciJobs}', note: 'Linux, Windows, real Postgres' },
  { label: 'Secrets needed to run it', value: '0', note: 'empty .env' },
  { label: 'Boundary rules enforced', value: '${boundaryRules}', note: 'plus a purity gate' },
] as const

/** Per-module test counts for day one's five modules, for the landing-page bar chart. */
export const TEST_SPREAD = [
${spreadRows}
] as const

/** What TEST_SPREAD sums to — day one's modules only, not the whole suite. */
export const DAY_ONE_TESTS = ${dayOneTotal}
`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const reportPath = args.report ?? runSuite()

  const generated = render({
    tests: readTestCounts(reportPath),
    ciJobs: countCiJobs(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')),
    boundaryRules: countBoundaryRules(readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf8')),
  })

  if (!args.check) {
    writeFileSync(OUT, generated)
    console.log('Wrote ' + OUT)
    return
  }

  let committed
  try {
    committed = readFileSync(OUT, 'utf8')
  } catch {
    console.error('evidence:check FAILED — ' + OUT + ' does not exist. Run `npm run evidence`.')
    process.exit(1)
  }
  // Compared with line endings normalised: .gitattributes may check this file out with
  // CRLF on Windows, which is not a stale number.
  const normalise = (s) => s.split('\r\n').join('\n')
  if (normalise(committed) !== normalise(generated)) {
    console.error(
      'evidence:check FAILED — src/config/evidence.ts disagrees with the suite, ci.yml, or\n' +
        'eslint.config.mjs. The landing page is printing a stale number about itself.\n' +
        'Fix: run `npm run evidence` and commit the result.',
    )
    process.exit(1)
  }
  console.log('evidence:check OK — every self-reported count matches its source.')
}

main()
