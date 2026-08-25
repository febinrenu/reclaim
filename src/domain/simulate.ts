/**
 * The policy simulator's pure core (BUILD_PLAN.md §1.4 point 1): "replay a
 * stored batch through the decision engine offline with no side effects, and
 * diff the resulting metrics against the baseline run." `DecisionInput` is
 * persisted verbatim as JSONB specifically so this is possible
 * (`src/domain/scenario/types.ts`'s own docstring) — `replayBatch` is nothing
 * more than `decide()` mapped over stored inputs under a (possibly different)
 * `Policy`. Zero I/O, so re-running it twice over the same inputs and the same
 * policy is byte-for-byte identical by construction — `decide()` is pure.
 *
 * Deliberately does NOT attempt to estimate what a simulated policy would have
 * *recovered* — that is the off-policy evaluation problem D8 already solves
 * properly (importance weighting against known propensities, `scripts/data/ope.py`).
 * A live batch's `outcome` was realized under whichever action was ACTUALLY
 * chosen at the time; reusing that outcome for a different, simulated action
 * would silently misattribute it. What this module reports instead — the
 * chosen-action distribution and the model's own stated EV — is exactly what a
 * reviewer needs to see the economics shift as a policy changes, without
 * quietly overclaiming a number this architecture cannot honestly produce
 * offline.
 */
import { decide } from '@/domain/decide'
import { addMilli, ZERO_MILLI, type MilliPaise, type Paise } from '@/domain/money'
import type { Decision, DecisionInput, Policy, ScenarioDefinition } from '@/domain/scenario/types'

export interface ReplayedDecision<A extends string> {
  readonly transactionId: string
  readonly amount: Paise
  readonly decision: Decision<A>
}

export function replayBatch<A extends string, F extends string>(
  inputs: readonly DecisionInput<A, F>[],
  policy: Policy<A>,
  scenario: ScenarioDefinition<A, F>,
): readonly ReplayedDecision<A>[] {
  return inputs.map((input) => ({
    transactionId: input.transactionId,
    amount: input.amount,
    decision: decide(input, policy, scenario),
  }))
}

export interface SimulationSummary<A extends string> {
  readonly count: number
  readonly countByAction: ReadonlyMap<A, number>
  /** The model's own stated EV, summed — not a realized outcome. Comparable
   * across two policies because both use the same trained recovery model;
   * only the cost table or risk threshold changed. */
  readonly evMilliTotal: MilliPaise
  readonly upliftMilliTotal: MilliPaise
  readonly escalatedCount: number
}

export function summarizeReplay<A extends string>(
  replayed: readonly ReplayedDecision<A>[],
  escalationAction: A,
): SimulationSummary<A> {
  const countByAction = new Map<A, number>()
  let evMilliTotal: MilliPaise = ZERO_MILLI
  let upliftMilliTotal: MilliPaise = ZERO_MILLI
  for (const r of replayed) {
    countByAction.set(r.decision.chosenAction, (countByAction.get(r.decision.chosenAction) ?? 0) + 1)
    evMilliTotal = addMilli(evMilliTotal, r.decision.ev)
    upliftMilliTotal = addMilli(upliftMilliTotal, r.decision.uplift)
  }
  return {
    count: replayed.length,
    countByAction,
    evMilliTotal,
    upliftMilliTotal,
    escalatedCount: countByAction.get(escalationAction) ?? 0,
  }
}
