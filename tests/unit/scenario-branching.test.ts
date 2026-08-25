/**
 * BUILD_PLAN.md §5.2's fourth gate, built for real: "a grep test asserts zero
 * `if (scenario === ...)` branches outside `scenario/registry.ts`." No such
 * file exists — the property held anyway (D12's B2B scenario never needed
 * one), but a promised guardrail that is only a sentence in a markdown file is
 * not actually a guardrail. This closes that gap directly, checked against
 * the property it is meant to protect: `decide()` and `computeEv` take a
 * `ScenarioDefinition` as data, so nothing in `src/domain/` or `src/app/`
 * should ever need to branch on which scenario it is holding.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const SCAN_ROOTS = ['src/domain', 'src/app', 'src/repositories', 'src/ports']
// A scenario's own `id` value appearing in its own definition file is not a
// branch — this file is the one legitimate place that string exists as data.
const ALLOWED_FILES = ['b2b-receivable.ts', 'subscription.ts']

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      yield* walk(full)
    } else if (extname(full) === '.ts' && !full.endsWith('.test.ts')) {
      yield full
    }
  }
}

describe('no scenario-conditional branching outside a scenario definition itself', () => {
  it('no source file compares a `scenario`/`.id` value with `===`', () => {
    const pattern = /\bscenario(?:\.id)?\s*===\s*['"`]/
    const offenders: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED_FILES.some((allowed) => file.endsWith(allowed))) continue
        const content = readFileSync(file, 'utf-8')
        if (pattern.test(content)) offenders.push(file)
      }
    }

    expect(offenders).toEqual([])
  })
})
