/**
 * The shared vocabulary both scenarios (subscription, and the D12 B2B receivables
 * chaser) are built from. BUILD_PLAN.md §5.9: sharing this by *type* rather than by
 * convention is what makes `Record<A, MilliPaise>` inside `Policy` exhaustive, so
 * adding an action is a compile error at exactly the places a human must make a new
 * decision, and nowhere else.
 */
import type { MilliPaise, Paise } from '@/domain/money'
import type { LogisticModel } from '@/domain/scoring/logistic'
import type { RiskInput, RiskRule } from '@/domain/risk/rules'

export type Locale = 'en-IN' | 'hi-IN-latn'

export type ExecutorCapability = 'silent' | 'requires_contact' | 'requires_human'

export type DisallowedReason =
  | 'stopping_rule' // retry-limit hit, or the risk gate fired — SYSTEM_SPEC.md §14
  | 'shock_suppressed'
  | 'no_contact'
  | 'opted_out'
  | 'capability_missing'

/**
 * The minimal facts `decide()` needs about one failed transaction at one instant.
 * Deliberately flat and JSON-shaped: this is exactly what BUILD_PLAN.md §5.1 A3
 * means by "`DecisionInput` is persisted verbatim as JSONB" — the policy simulator
 * replays this same object later under a different `Policy`, so nothing that
 * produced it (a database row, a clock reading) may leak in as anything other than
 * a plain value already captured here.
 */
export interface DecisionInput<A extends string, F extends string> {
  readonly transactionId: string
  readonly eventId: string
  readonly nowMs: number
  readonly amount: Paise
  readonly retryCount: number
  readonly contactsLast7d: number
  readonly expectedLtv: Paise
  readonly features: Readonly<Record<F, number>>
  readonly risk: RiskInput
  readonly shockSuppressed: boolean
  readonly optedOut: boolean
  /** Whether the channel an action needs is actually available — e.g. no phone on file. */
  readonly capabilityAvailable: Readonly<Record<A, boolean>>
}

/**
 * Every action is always present, including disallowed ones, so the counterfactual
 * is on record — SYSTEM_SPEC.md §11 and BUILD_PLAN.md §5.3.
 */
export interface EvBreakdown<A extends string> {
  readonly action: A
  readonly allowed: boolean
  readonly disallowedReason: DisallowedReason | null
  readonly pBase: number
  readonly pRecover: number
  readonly expectedGain: MilliPaise
  readonly interventionCost: MilliPaise
  readonly computeCost: MilliPaise
  readonly riskPenalty: MilliPaise
  readonly contactFatigueCost: MilliPaise
  readonly ev: MilliPaise
}

export interface Decision<A extends string> {
  readonly chosenAction: A
  readonly breakdown: readonly EvBreakdown<A>[]
  readonly ev: MilliPaise
  /** `EV(chosen) - EV(nullAction)` — BUILD_PLAN.md §6.1 correction 1. The number
   * that answers "did acting actually help", since `EV(DO_NOTHING)` is not zero. */
  readonly uplift: MilliPaise
  readonly riskScore: number
  readonly riskGated: boolean
}

export interface Policy<A extends string> {
  readonly interventionCost: Readonly<Record<A, MilliPaise>>
  readonly computeCost: Readonly<Record<A, MilliPaise>>
  /** Per-action effect on recovery odds, in logit space. 0 for the null action —
   * see src/domain/scoring/logistic.ts's `applyActionLift`. */
  readonly liftLogit: Readonly<Record<A, number>>
  readonly riskThreshold: number
  readonly riskRules: readonly RiskRule[]
  readonly maxRetries: number
  /** BUILD_PLAN.md §6.1 correction 2: only actions that contact the customer accrue
   * fatigue cost. */
  readonly contactFatigueActions: readonly A[]
  /** SYSTEM_SPEC.md §15: actions redirected away from when a systemic shock is
   * suppressing a bank/error-code pair — typically an immediate retry. */
  readonly shockSuppressedActions: readonly A[]
}

/** BUILD_PLAN.md §6.1 correction 2's churn-hazard table, keyed by contacts in the
 * trailing 7 days. Shared across every scenario: the mechanism (more recent contact,
 * higher churn hazard) is not scenario-specific, even though the actions it applies
 * to are. */
export const CHURN_HAZARD_BY_CONTACTS: readonly number[] = [0.0005, 0.002, 0.004, 0.008]

export function churnHazard(contactsLast7d: number): number {
  const idx = Math.min(Math.max(contactsLast7d, 0), CHURN_HAZARD_BY_CONTACTS.length - 1)
  const hazard = CHURN_HAZARD_BY_CONTACTS[idx]
  if (hazard === undefined) throw new Error('unreachable: idx clamped to array bounds')
  return hazard
}

export interface ScenarioDefinition<A extends string, F extends string> {
  readonly id: string
  readonly actions: readonly A[]
  /** `EV = 0` by definition is the spec's claim; BUILD_PLAN.md §6.1 correction 1
   * shows it is not, because organic recovery exists. This action is still the
   * reference point every uplift is measured against — it is simply not zero. */
  readonly nullAction: A
  readonly escalationAction: A
  readonly features: readonly F[]
  readonly model: LogisticModel<F>
  readonly capabilityOf: Readonly<Record<A, ExecutorCapability>>
  readonly requiresContact: (action: A) => boolean
  readonly defaultPolicy: Policy<A>
}
