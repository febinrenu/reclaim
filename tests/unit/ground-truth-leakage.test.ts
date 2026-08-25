/**
 * BUILD_PLAN.md §5.2's third gate, built for real: "a leakage test forbids
 * `ground-truth.repo.ts` from being imported by `src/app/worker/**`." No such
 * test existed — the property held anyway (the worker never had reason to
 * touch it), but an unenforced promise is not a guardrail. `ground_truth` is
 * the oracle-counterfactual table (BUILD_PLAN.md §6.3, Track B): the live
 * decision pipeline must never see it, for the identical reason
 * `eval/test_oracle_firewall.py` forbids the recovery scorer's own training
 * and evaluation path from seeing the Python-side oracle file — using held-out
 * ground truth to audit a decision after the fact is legitimate; using it to
 * make the decision is the exact circularity both firewalls exist to prevent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')
const SRC_DIR = join(REPO_ROOT, 'src')
const WORKER_DIR = join(SRC_DIR, 'app', 'worker')

const BANNED_SUBSTRING = '@/repositories/ground-truth'
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g

function listTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
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
  if (specifier.startsWith('@/')) return resolveWithExtensions(join(SRC_DIR, specifier.slice(2)))
  if (specifier.startsWith('.')) return resolveWithExtensions(join(dirname(fromFile), specifier))
  return null
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

describe('ground_truth leakage: src/app/worker/** never reaches the oracle table, even indirectly', () => {
  it('no transitive import of ground-truth.repo.ts', () => {
    const startFiles = listTsFiles(WORKER_DIR)
    const visited = new Set<string>()
    const violations: string[] = []
    const queue: { file: string; path: readonly string[] }[] = startFiles.map((f) => ({ file: f, path: [f] }))

    while (queue.length > 0) {
      const { file, path } = queue.shift()!
      if (visited.has(file)) continue
      visited.add(file)

      for (const specifier of importsOf(file)) {
        if (specifier.includes(BANNED_SUBSTRING)) {
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
    expect(visited.size).toBeGreaterThan(startFiles.length)
  })

  it('the walk itself can detect a violation (self-test, not just a passing example)', () => {
    const violatingSpecifier = '@/repositories/ground-truth.repo'
    expect(violatingSpecifier.includes(BANNED_SUBSTRING)).toBe(true)
  })
})
