/**
 * Picks one real audit row to use as a concrete "here's a real decision, in full"
 * example — imported by both the homepage and the audit page, so they tell the
 * SAME real story rather than two independently hand-picked ones.
 *
 * The heuristic favors a row where some other action had a strictly higher
 * P(recover) than the action actually chosen — the exact claim this whole product
 * rests on ("Reclaim prices every action, and routinely picks a lower-probability
 * one because it's worth more"), demonstrated by a real number, not asserted.
 */
import type { AuditRowData } from './audit-row'

export interface StoryExample {
  readonly row: AuditRowData
  /** The action with the highest P(recover) among the ones considered, when it
   * differs from what was actually chosen. Null when the chosen action already
   * had the highest probability (still a valid, just less dramatic, example). */
  readonly higherProbabilityAction: { readonly action: string; readonly pRecover: number } | null
}

export function pickStoryRow(rows: readonly AuditRowData[]): StoryExample | null {
  let best: StoryExample | null = null
  let bestGap = -Infinity

  for (const row of rows) {
    if (row.breakdown === null || row.breakdown.length === 0) continue

    const chosen = row.breakdown.find((b) => b.action === row.chosenAction)
    if (chosen === undefined) continue

    let topOther: { action: string; pRecover: number } | null = null
    for (const b of row.breakdown) {
      if (b.action === row.chosenAction) continue
      if (topOther === null || b.pRecover > topOther.pRecover) topOther = { action: b.action, pRecover: b.pRecover }
    }

    const gap = topOther !== null ? topOther.pRecover - chosen.pRecover : -Infinity
    if (gap > bestGap) {
      bestGap = gap
      best = {
        row,
        higherProbabilityAction: topOther !== null && topOther.pRecover > chosen.pRecover ? topOther : null,
      }
    }
  }

  if (best !== null) return best

  // No row shows a probability-vs-value gap (or none has a parseable breakdown at
  // all) — fall back to the single most recent row with a breakdown, so the
  // example is still real rather than fabricated.
  const fallback = rows.find((r) => r.breakdown !== null && r.breakdown.length > 0)
  return fallback === undefined ? null : { row: fallback, higherProbabilityAction: null }
}
