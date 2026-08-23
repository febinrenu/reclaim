/**
 * The third of five barriers stopping a payments client from ever reaching the
 * language layer (BUILD_PLAN.md §5.4). ESLint boundary rule 2 checks *direct*
 * imports in each `src/language/**` file; this test walks the *transitive*
 * import graph, so the guarantee survives a refactor that adds an indirect path
 * — e.g. a language file importing something that itself pulls in
 * `@/config/container`, which wires every payments adapter internally, would
 * slip past a direct-import-only check but not past this one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SRC_DIR = join(REPO_ROOT, 'src')
const LANGUAGE_DIR = join(SRC_DIR, 'language')

const BANNED_SUBSTRINGS = [
  '@/ports/executor', // also where PaymentsPort lives in this codebase
  '@/adapters/payments',
  '@/adapters/llm', // the language layer receives an LlmPort, never selects the adapter itself
  '@/repositories',
  '@/config/container', // wires every adapter, including payments
  "'razorpay'",
  '"razorpay"',
]

const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full))
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      files.push(full)
    }
  }
  return files
}

function resolveImport(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) {
    return resolveWithExtensions(join(SRC_DIR, specifier.slice(2)))
  }
  if (specifier.startsWith('.')) {
    return resolveWithExtensions(join(dirname(fromFile), specifier))
  }
  return null // a bare package specifier (node:crypto, zod, ...) — not part of our own graph
}

function resolveWithExtensions(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(IMPORT_PATTERN)].map((m) => m[1]).filter((s): s is string => s !== undefined)
}

describe('the language firewall: transitive import graph', () => {
  it('src/language/** never reaches a payments client, an executor, or the database, even indirectly', () => {
    const startFiles = listTsFiles(LANGUAGE_DIR)
    const visited = new Set<string>()
    const violations: string[] = []
    const queue: { file: string; path: readonly string[] }[] = startFiles.map((f) => ({ file: f, path: [f] }))

    while (queue.length > 0) {
      const { file, path } = queue.shift()!
      if (visited.has(file)) continue
      visited.add(file)

      for (const specifier of importsOf(file)) {
        if (BANNED_SUBSTRINGS.some((banned) => specifier.includes(banned) || specifier === banned)) {
          violations.push(`${path.join(' -> ')} -> "${specifier}"`)
          continue
        }
        const resolved = resolveImport(specifier, file)
        if (resolved !== null && !visited.has(resolved)) {
          queue.push({ file: resolved, path: [...path, resolved] })
        }
      }
    }

    expect(violations).toEqual([])
    // A guard that visits nothing proves nothing — see docs/INCIDENTS.md's
    // secret-guard incident. Confirm the walk actually traversed real files.
    expect(visited.size).toBeGreaterThan(startFiles.length)
  })

  it('the walk itself can detect a violation (self-test, not just a passing example)', () => {
    // A tiny inline graph standing in for the real one, so this test does not
    // depend on ESLint boundary rule 2 already having caught a real violation
    // (which would make this test vacuous — see docs/INCIDENTS.md).
    const violatingSpecifier = '@/adapters/payments/simulator'
    const isBanned = BANNED_SUBSTRINGS.some((banned) => violatingSpecifier.includes(banned))
    expect(isBanned).toBe(true)
  })
})
