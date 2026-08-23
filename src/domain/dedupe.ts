/**
 * The pure algorithm behind "the same event twice yields one audit row." The actual
 * authority is a database UNIQUE constraint (BUILD_PLAN.md §5.1 A1, verified for real
 * against both drivers in tests/integration/repositories.test.ts) — this is not a
 * substitute for that. It exists so property P2 (BUILD_PLAN.md §6.9) can be checked
 * over 1,000 generated event streams with zero I/O: first-write-wins keyed dedup is
 * the algorithm a UNIQUE-constrained insert-if-absent implements, so proving this
 * pure version correct is what a fast, no-database property test can actually cover.
 */
export function dedupeByEventId<T extends { readonly eventId: string }>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    if (seen.has(item.eventId)) continue
    seen.add(item.eventId)
    result.push(item)
  }
  return result
}
