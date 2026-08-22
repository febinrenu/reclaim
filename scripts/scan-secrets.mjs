#!/usr/bin/env node
/**
 * Credential scanner. Used by the pre-commit hook and by CI, so there is exactly
 * one pattern list rather than two that drift apart.
 *
 * This exists in Node rather than shell for two reasons. It behaves identically on
 * Windows, where this project is developed and the demo is recorded. And more
 * importantly it can test itself: `--self-test` asserts the patterns actually match
 * known-bad strings and actually ignore known-good ones.
 *
 * That self-test is not ceremony. The first version of this guard was a shell
 * one-liner that used BRE interval syntax with `grep -E`, where `\{20,\}` is a
 * literal brace rather than a repetition count. It matched nothing at all, and it
 * reported success on a file containing a credential-shaped string. A guard that
 * cannot fire is worse than no guard, because it manufactures confidence. The
 * self-test is what makes this one trustworthy.
 *
 * Usage:
 *   node scripts/scan-secrets.mjs --staged     scan files staged for commit
 *   node scripts/scan-secrets.mjs --tracked    scan every tracked file
 *   node scripts/scan-secrets.mjs --self-test  prove the patterns work
 *   node scripts/scan-secrets.mjs <path...>    scan specific paths
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'

/**
 * Each pattern needs a `bad` example that must match and a `good` example that must
 * not, so the self-test covers both directions. A pattern that matches everything
 * is as useless as one that matches nothing.
 */
const PATTERNS = [
  {
    name: 'Razorpay live key',
    // Test keys are rzp_test_ and are entirely fine; only live keys can move money.
    re: /rzp_live_[A-Za-z0-9]{10,}/,
    bad: 'rzp_live_AbCdEf1234567890',
    good: 'rzp_test_AbCdEf1234567890',
  },
  {
    name: 'Groq API key',
    re: /gsk_[A-Za-z0-9]{20,}/,
    bad: 'gsk_abcdefghijklmnopqrstuvwxyz123456',
    good: 'gsk_short',
  },
  {
    name: 'Supabase secret key',
    re: /sb_secret_[A-Za-z0-9_-]{20,}/,
    bad: 'sb_secret_abcdefghijklmnopqrstuvwxyz',
    good: 'sb_publishable_abcdefghijklmnop',
  },
  {
    name: 'JWT, the shape of a Supabase service_role key',
    re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
    bad: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0Ijo5OTk5fQ',
    good: 'eyJhbGciOiJIUzI1NiJ9',
  },
  {
    name: 'AWS access key id',
    re: /AKIA[0-9A-Z]{16}/,
    bad: 'AKIAIOSFODNN7EXAMPLE',
    good: 'AKIA-not-a-key',
  },
  {
    name: 'private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    bad: '-----BEGIN RSA PRIVATE KEY-----',
    good: '-----BEGIN CERTIFICATE-----',
  },
]

/**
 * Files that legitimately contain these prefixes because they document them.
 * Kept deliberately short: every entry here is a hole in the guard, so each one
 * has to earn its place.
 */
const ALLOWLIST = new Set([
  // This file: the patterns and their test examples live here.
  'scripts/scan-secrets.mjs',
  // Documents the prefixes it refuses.
  '.githooks/pre-commit',
  // Shows the shape of each variable, with every value blank.
  '.env.example',
  '.github/workflows/ci.yml',
  // Planning and product documents that discuss credential handling.
  'BUILD_PLAN.md',
  'SYSTEM_SPEC.md',
  'README.md',
  'docs/SETUP.md',
  // Quotes the exact string from the incident where this guard failed open. The
  // write-up is unreadable without it, and this guard blocking its own postmortem
  // was itself the first evidence that the fix works.
  'docs/INCIDENTS.md',
])

/** A real secret file must never be committed, whatever .gitignore currently says. */
const FORBIDDEN_PATHS = [/^\.env$/, /^\.env\.local$/, /^\.env\..*\.local$/]

const MAX_BYTES = 2 * 1024 * 1024

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function selfTest() {
  let failures = 0
  for (const p of PATTERNS) {
    if (!p.re.test(p.bad)) {
      console.error(`SELF-TEST FAIL: ${p.name} did not match its known-bad example.`)
      console.error(`  pattern: ${p.re}`)
      console.error(`  input:   ${p.bad}`)
      failures++
    }
    if (p.re.test(p.good)) {
      console.error(`SELF-TEST FAIL: ${p.name} matched its known-good example.`)
      console.error(`  pattern: ${p.re}`)
      console.error(`  input:   ${p.good}`)
      failures++
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} self-test failure(s). The guard is not trustworthy. Fix it.`)
    process.exit(1)
  }
  console.log(`secret scanner self-test passed: ${PATTERNS.length} patterns, both directions`)
}

function scan(paths) {
  const problems = []

  for (const path of paths) {
    const normalised = path.replace(/\\/g, '/')

    if (FORBIDDEN_PATHS.some((re) => re.test(normalised))) {
      problems.push({ path: normalised, why: 'is a secret file and must never be committed' })
      continue
    }

    if (ALLOWLIST.has(normalised)) continue
    if (!existsSync(path)) continue
    try {
      if (statSync(path).isDirectory()) continue
      if (statSync(path).size > MAX_BYTES) continue
    } catch {
      continue
    }

    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    // Skip anything that looks binary rather than trying to interpret it. A NUL byte
    // is the reliable tell. Written as a charCode rather than an escape sequence so
    // this source file stays plain ASCII: an earlier version embedded a raw NUL,
    // which made git treat the scanner itself as a binary file.
    if (text.indexOf(String.fromCharCode(0)) !== -1) continue

    for (const p of PATTERNS) {
      const m = p.re.exec(text)
      if (m === null) continue
      const line = text.slice(0, m.index).split('\n').length
      problems.push({ path: normalised, why: `looks like a ${p.name} on line ${line}` })
      break
    }
  }

  if (problems.length > 0) {
    console.error('')
    for (const p of problems) console.error(`  BLOCKED: ${p.path} ${p.why}`)
    console.error('')
    console.error('  If a credential really was committed, rotate it now. Removing it from')
    console.error('  the tree does not remove it from history, and history is public.')
    console.error('')
    console.error('  For a genuine false positive, add the path to ALLOWLIST in')
    console.error('  scripts/scan-secrets.mjs with a comment saying why.')
    console.error('')
    process.exit(1)
  }

  console.log(`secret scan clean: ${paths.length} file(s) checked`)
}

const args = process.argv.slice(2)

if (args.includes('--self-test')) {
  selfTest()
} else if (args.includes('--staged')) {
  selfTest()
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACM']).trim()
  scan(out === '' ? [] : out.split('\n'))
} else if (args.includes('--tracked')) {
  selfTest()
  const out = git(['ls-files']).trim()
  scan(out === '' ? [] : out.split('\n'))
} else if (args.length > 0) {
  selfTest()
  scan(args)
} else {
  console.error('usage: scan-secrets.mjs [--staged | --tracked | --self-test | <path...>]')
  process.exit(2)
}
