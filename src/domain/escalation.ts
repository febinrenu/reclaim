/**
 * Escalation policy — PURE. No Date, no I/O, same contract as `decide()`.
 *
 * Two questions, both of which want to be answerable without a database: *why* is a
 * human being involved, and *by when* must they respond. Kept here rather than inline in
 * the worker so both are unit-testable and so the SLA is one auditable table instead of
 * a magic number at a call site.
 *
 * `classifyEscalation` deliberately does not collapse its three cases. A risk-gated
 * escalation is a different job from an exhausted-retries escalation: the first is a
 * possible fraud signal where acting wrongly is expensive in both directions, the second
 * is a collections conversation, and the third is a genuine judgment call the model
 * priced and lost. Reporting them as one bucket would throw away the most useful thing
 * the queue knows about each item.
 */

export type EscalationReason = 'risk_gated' | 'stopping_rule' | 'economic'

/** The closed vocabulary an operator resolves a work item with. */
export const ESCALATION_RESOLUTIONS = [
  'paid',
  'promised_to_pay',
  'disputed',
  'uncontactable',
  'written_off',
] as const

export type EscalationResolution = (typeof ESCALATION_RESOLUTIONS)[number]

export function isEscalationResolution(value: unknown): value is EscalationResolution {
  return typeof value === 'string' && (ESCALATION_RESOLUTIONS as readonly string[]).includes(value)
}

/**
 * Which resolutions mean the money actually arrived.
 *
 * `promised_to_pay` deliberately does NOT count. A promise is not a payment, and
 * treating it as one is precisely the self-flattering accounting this project exists to
 * avoid — it would let the queue report recovery for work that has not recovered
 * anything yet. If the promise is kept, a real `payment.captured` webhook will settle
 * the transaction through the normal path and be counted there, once.
 */
export function isRecoveredResolution(resolution: EscalationResolution): boolean {
  return resolution === 'paid'
}

/**
 * Which resolutions close the case with no more recovery attempts expected. Used to
 * record a final, human-observed negative outcome for the customer rather than leaving
 * the transaction hanging in `failed` forever.
 */
export function isTerminalNegativeResolution(resolution: EscalationResolution): boolean {
  return resolution === 'uncontactable' || resolution === 'written_off' || resolution === 'disputed'
}

export interface ClassifyEscalationInput {
  /** The risk gate fired: every non-escalation action was structurally infeasible. */
  readonly riskGated: boolean
  /** Retries were exhausted (`retryCount >= policy.maxRetries`). */
  readonly stoppingRuleHit: boolean
}

/**
 * Order matters and is not arbitrary. Both conditions can hold at once — a transaction
 * can be out of retries *and* risk-gated — and when they do, `risk_gated` is the more
 * urgent and more informative fact, so it wins. `decide()` itself treats the gate as a
 * hard feasibility constraint rather than a cost, for the same reason.
 */
export function classifyEscalation(input: ClassifyEscalationInput): EscalationReason {
  if (input.riskGated) return 'risk_gated'
  if (input.stoppingRuleHit) return 'stopping_rule'
  return 'economic'
}

/**
 * Response deadlines, in hours, by reason.
 *
 * These are a stated policy, not a measurement: this project has no real operations team
 * whose actual response times could be observed, and inventing a number that looked
 * derived would be worse than naming one that is plainly a choice. The ordering is the
 * defensible part — a possible-fraud review is more urgent than a collections call, and
 * both are more urgent than a judgment call the model already priced.
 */
export const ESCALATION_SLA_HOURS: Readonly<Record<EscalationReason, number>> = {
  risk_gated: 4,
  stopping_rule: 24,
  economic: 48,
}

/** Injected clock time in, deadline out. Pure, so the worker's clock stays the only one. */
export function slaDueAtMs(createdAtMs: number, reason: EscalationReason): number {
  return createdAtMs + ESCALATION_SLA_HOURS[reason] * 60 * 60 * 1000
}

/** Overdue is asked about a specific instant, never about "now" read from inside here. */
export function isOverdue(slaDueAtMs: number, nowMs: number): boolean {
  return nowMs > slaDueAtMs
}
