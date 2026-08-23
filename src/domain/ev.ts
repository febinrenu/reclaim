/**
 * Expected value for one action, in one state. This is the arithmetic half of
 * SYSTEM_SPEC.md §4's formula, corrected by BUILD_PLAN.md §6.1: `DO_NOTHING` is not
 * zero (correction 1), and contact fatigue is its own term rather than folded into
 * `RiskPenalty` (correction 2).
 *
 * Every term is rounded exactly once, at the point it is computed, so that the final
 * sum is a sum of integers rather than a sum of roundings — see
 * src/domain/money.ts's `scaleMilli`.
 */
import { expectedValueOf, subMilli, addMilli, type MilliPaise, type Paise, ZERO_MILLI } from '@/domain/money'
import { applyActionLift } from '@/domain/scoring/logistic'
import { churnHazard, type DisallowedReason, type EvBreakdown, type Policy } from '@/domain/scenario/types'

export interface EvContext<A extends string> {
  readonly action: A
  readonly pBase: number
  readonly amount: Paise
  readonly contactsLast7d: number
  readonly expectedLtv: Paise
  readonly allowed: boolean
  readonly disallowedReason: DisallowedReason | null
}

/**
 * Always computed, even for a disallowed action — SYSTEM_SPEC.md §11: "The EV
 * calculation still runs in full for the audit trail even when the risk gate wins."
 * The counterfactual belongs on the record precisely when it was not acted on.
 */
export function computeEv<A extends string>(
  ctx: EvContext<A>,
  policy: Policy<A>,
): EvBreakdown<A> {
  const pRecover = applyActionLift(ctx.pBase, policy.liftLogit[ctx.action])
  const expectedGain = expectedValueOf(ctx.amount, pRecover)

  const interventionCost = policy.interventionCost[ctx.action]
  const computeCost = policy.computeCost[ctx.action]

  const contactFatigueCost: MilliPaise = policy.contactFatigueActions.includes(ctx.action)
    ? scaleLtvByHazard(ctx.expectedLtv, churnHazard(ctx.contactsLast7d))
    : ZERO_MILLI

  // RiskPenalty is logged as zero here deliberately: BUILD_PLAN.md §6.1 correction 3
  // makes the risk gate a hard feasibility constraint (decide() removes the action
  // from the allowed set) rather than a subtracted penalty a large enough amount
  // could out-compete. A penalty term would double-count what `allowed: false`
  // already expresses, and would reintroduce exactly the bug correction 3 fixes.
  const riskPenalty: MilliPaise = ZERO_MILLI

  const ev = subMilli(
    subMilli(subMilli(expectedGain, interventionCost), computeCost),
    addMilli(riskPenalty, contactFatigueCost),
  )

  return {
    action: ctx.action,
    allowed: ctx.allowed,
    disallowedReason: ctx.disallowedReason,
    pBase: ctx.pBase,
    pRecover,
    expectedGain,
    interventionCost,
    computeCost,
    riskPenalty,
    contactFatigueCost,
    ev,
  }
}

function scaleLtvByHazard(ltv: Paise, hazard: number): MilliPaise {
  // expectedValueOf is written for a recovery probability, but is exactly "amount
  // times a value in [0, 1]" regardless of what that value means, and churn hazards
  // are documented to stay well inside [0, 1] (max 0.008) — see
  // src/domain/scenario/types.ts's CHURN_HAZARD_BY_CONTACTS.
  return expectedValueOf(ltv, hazard)
}
