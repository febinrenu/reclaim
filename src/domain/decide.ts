/**
 * `decide()` — PURE. Synchronous. No Date, no Math.random, no I/O. This is the one
 * function BUILD_PLAN.md §5.1 commitment A3 is written around: everything else in
 * the decision surface (the policy simulator, the EV explorer, this whole unit
 * suite) exists because this function is a pure `(input, policy, scenario) ->
 * decision` with nothing hidden in a closure.
 *
 * Order of operations, and why it is this order:
 *   1. Score the null action's row once (`pBase`) — the organic baseline every
 *      other action's own row is compared against.
 *   2. Evaluate the risk gate. BUILD_PLAN.md §6.1 correction 3: this is a hard
 *      feasibility constraint, not a subtracted penalty, because a fixed penalty can
 *      always be out-competed by a large enough amount — see property P10.
 *   3. Compute every action's EV, including disallowed ones, so the counterfactual
 *      is always on the audit record (SYSTEM_SPEC.md §11). Each action is scored
 *      off its *own* row (BUILD_PLAN.md §6.2's "one model with action features"),
 *      built by `scenario.buildModelRow` and scored via
 *      src/domain/scoring/recovery-model.ts's `scoreRow` — never a lift applied to
 *      `pBase`, since the action's effect is already inside the trained coefficients.
 *   4. argmax over the allowed subset, with a documented deterministic tie-break
 *      (property P5): among actions tied for the maximum EV, the one earliest in
 *      `scenario.actions` wins. `Array.prototype.filter` and a strict `>` comparison
 *      make this the natural result of a single left-to-right pass, not a rule that
 *      has to be bolted on separately.
 */
import { scoreRow } from '@/domain/scoring/recovery-model'
import { evaluateRisk } from '@/domain/risk/rules'
import { computeEv } from '@/domain/ev'
import { subMilli } from '@/domain/money'
import type { Decision, DecisionInput, DisallowedReason, EvBreakdown, Policy, ScenarioDefinition } from '@/domain/scenario/types'

function contactAvailability<A extends string, F extends string>(
  input: DecisionInput<A, F>,
  scenario: ScenarioDefinition<A, F>,
): { readonly anyContactActionAvailable: boolean } {
  const contactActions = scenario.actions.filter((a) => scenario.requiresContact(a))
  const anyContactActionAvailable = contactActions.some((a) => input.capabilityAvailable[a])
  return { anyContactActionAvailable }
}

function resolveAllowed<A extends string, F extends string>(
  action: A,
  input: DecisionInput<A, F>,
  policy: Policy<A>,
  scenario: ScenarioDefinition<A, F>,
  stoppingRuleHit: boolean,
  anyContactActionAvailable: boolean,
): { readonly allowed: boolean; readonly reason: DisallowedReason | null } {
  if (stoppingRuleHit) {
    return action === scenario.escalationAction
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'stopping_rule' }
  }

  if (scenario.requiresContact(action)) {
    if (input.optedOut) return { allowed: false, reason: 'opted_out' }
    if (!input.capabilityAvailable[action]) {
      // Distinguish "this one channel is down" from "this customer cannot be
      // reached by any channel at all" — the latter is a different, and worse,
      // situation for the audit trail to say plainly rather than blur together.
      return {
        allowed: false,
        reason: anyContactActionAvailable ? 'capability_missing' : 'no_contact',
      }
    }
  }

  if (input.shockSuppressed && policy.shockSuppressedActions.includes(action)) {
    return { allowed: false, reason: 'shock_suppressed' }
  }

  return { allowed: true, reason: null }
}

/** The documented tie-break for property P5: first, in `scenario.actions` order,
 * among the actions with the strictly-maximal EV. */
function pickArgmax<A extends string>(allowed: readonly EvBreakdown<A>[]): EvBreakdown<A> {
  const first = allowed[0]
  if (first === undefined) {
    throw new Error(
      'decide: no action is allowed. A scenario must always leave at least one action ' +
        'allowed (normally the null action, or the escalation action under a stopping rule).',
    )
  }
  let best = first
  for (let i = 1; i < allowed.length; i++) {
    const candidate = allowed[i]
    if (candidate !== undefined && candidate.ev > best.ev) best = candidate
  }
  return best
}

export function decide<A extends string, F extends string>(
  input: DecisionInput<A, F>,
  policy: Policy<A>,
  scenario: ScenarioDefinition<A, F>,
): Decision<A> {
  const pBase = scoreRow(scenario.model, scenario.buildModelRow(input.features, scenario.nullAction))
  const risk = evaluateRisk(input.risk, policy.riskThreshold, policy.riskRules)
  const stoppingRuleHit = input.retryCount >= policy.maxRetries || risk.gated
  const { anyContactActionAvailable } = contactAvailability(input, scenario)

  const breakdown = scenario.actions.map((action) => {
    const { allowed, reason } = resolveAllowed(
      action,
      input,
      policy,
      scenario,
      stoppingRuleHit,
      anyContactActionAvailable,
    )
    const pRecover =
      action === scenario.nullAction
        ? pBase
        : scoreRow(scenario.model, scenario.buildModelRow(input.features, action))
    return computeEv(
      {
        action,
        pBase,
        pRecover,
        amount: input.amount,
        contactsLast7d: input.contactsLast7d,
        expectedLtv: input.expectedLtv,
        allowed,
        disallowedReason: reason,
      },
      policy,
    )
  })

  const chosen = pickArgmax(breakdown.filter((b) => b.allowed))
  const nullBreakdown = breakdown.find((b) => b.action === scenario.nullAction)
  if (nullBreakdown === undefined) {
    throw new Error('decide: scenario.nullAction is not a member of scenario.actions')
  }

  return {
    chosenAction: chosen.action,
    breakdown,
    ev: chosen.ev,
    uplift: subMilli(chosen.ev, nullBreakdown.ev),
    riskScore: risk.score,
    riskGated: risk.gated,
  }
}
