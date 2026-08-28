/**
 * Checkout abandonment, run through the real decision engine.
 *
 * The third and last of the inputs Track 03 names ("from payment failures and checkout
 * abandonment to overdue receivables"). Structured deliberately as a thin additive
 * pipeline in the same shape as `src/app/b2b/process-invoice-event.ts`, for the same
 * reason that one exists: it reuses `decide()`, the live feature builder, the live risk
 * signals, the `webhook_events`-backed idempotency authority and the audit trail, and it
 * touches no existing code path. Nothing in `process-event.ts` or the webhook route
 * changes to support this.
 *
 * **What an abandoned checkout is here.** A Razorpay Order that was created and never
 * paid — `status` of `created` (never attempted) or `attempted` (a charge was tried and
 * did not complete), with `amount_paid` of zero, older than some sweep window. Razorpay
 * emits no "abandonment" webhook, because abandonment is the absence of an event rather
 * than an event; it has to be found by looking, which is what
 * `scripts/sweep-abandoned-checkouts.ts` does against the real Orders API.
 *
 * **Why there is no retry action.** See `CHECKOUT_SCENARIO`'s own docstring: no charge was
 * ever completed, so there is nothing to retry, and leaving `RETRY_NOW` in the menu would
 * let a ₹0-cost no-op win the argmax. The menu is `PAYMENT_LINK`, `WHATSAPP_NUDGE`,
 * `ESCALATE_HUMAN`, `DO_NOTHING`.
 *
 * **The honest caveat, repeated here because this is where decisions actually get made.**
 * The scorer is the subscription one, trained on payment failures rather than on abandoned
 * carts. `P(recover | state, action)` is a borrowed estimate on a different distribution
 * and is *not calibrated for this one*. This project reports no calibration or off-policy
 * number for checkout abandonment, because it has no held-out abandonment data to compute
 * one from. What generalises here is the machinery, not the probability. `docs/adr/0012`.
 */
import { createHash } from 'node:crypto'
import type { Deps } from '@/config/container'
import * as webhookEventsRepo from '@/repositories/webhook-events.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as customersRepo from '@/repositories/customers.repo'
import * as actionAttemptsRepo from '@/repositories/action-attempts.repo'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import * as escalationsRepo from '@/repositories/escalations.repo'
import { eventId as toEventId, transactionId as toTransactionId, customerId as toCustomerId } from '@/domain/ids'
import { paise } from '@/domain/money'
import { decide } from '@/domain/decide'
import { CHECKOUT_SCENARIO, CHECKOUT_DEFAULT_POLICY, type CheckoutAction } from '@/domain/scenario/checkout'
import { buildLiveFeatures } from '@/app/worker/live-features'
import { buildLiveRiskSignals } from '@/app/worker/live-risk-signals'
import { classifyEscalation, slaDueAtMs } from '@/domain/escalation'
import type { Jsonish } from '@/domain/json'

export interface AbandonedCheckoutInput {
  readonly eventId: string
  /** The Razorpay order id — the transaction identity for this scenario. */
  readonly orderId: string
  readonly customerId: string
  readonly amountPaise: number
  /** How long the order has sat unpaid. Feeds the copy's overdue band. */
  readonly minutesSinceCreated: number
  /** `attempted` means a charge was tried and failed; `created` means never tried. */
  readonly orderStatus: 'created' | 'attempted'
  readonly optedOut?: boolean | undefined
  /** A real payment landed after all — nothing left to decide. */
  readonly paid?: boolean | undefined
}

export interface AbandonedCheckoutResult {
  readonly duplicate: boolean
  readonly chosenAction: CheckoutAction | 'PAID'
  readonly pRecover: number | null
  readonly evMilli: number | null
  readonly upliftMilli: number | null
  readonly riskGated: boolean
  readonly escalationId: string | null
}

function idempotencyKeyFor(eventId: string, action: string): string {
  return createHash('sha256').update(`${eventId}|${action}|1`).digest('hex')
}

const NOTHING_TO_DECIDE = {
  duplicate: false,
  chosenAction: 'PAID',
  pRecover: null,
  evMilli: null,
  upliftMilli: null,
  riskGated: false,
  escalationId: null,
} as const

export async function processAbandonedCheckout(
  deps: Deps,
  input: AbandonedCheckoutInput,
): Promise<AbandonedCheckoutResult> {
  const nowMs = deps.clock.nowMs()
  const evtId = toEventId(input.eventId)
  const txnId = toTransactionId(input.orderId)
  const custId = toCustomerId(input.customerId)

  // The same idempotency authority the Razorpay path uses: a UNIQUE constraint in the
  // same transaction as the write, not a lock in a second datastore. A sweep that runs
  // twice over the same still-unpaid order must not decide twice.
  const inserted = await deps.sql.transaction((tx) =>
    webhookEventsRepo.insertIfAbsent(tx, {
      eventId: evtId,
      eventType: 'checkout.abandoned',
      payload: { ...input } as unknown as Jsonish,
    }),
  )
  if (!inserted) return { ...NOTHING_TO_DECIDE, duplicate: true }

  await customersRepo.upsertCustomer(deps.sql, { id: custId })
  const existingTxn = await transactionsRepo.findTransactionById(deps.sql, txnId)
  const chaseRounds = existingTxn?.retryCount ?? 0

  await transactionsRepo.upsertTransaction(deps.sql, {
    id: txnId,
    customerId: custId,
    amount: paise(input.amountPaise),
    status: input.paid === true ? 'recovered' : 'failed',
    scenario: 'checkout_abandonment',
  })

  if (input.paid === true) {
    // Mirrors process-event.ts's own recovered short-circuit: the cart converted, so
    // there is nothing to price. The outcome is still banked, exactly once.
    await deps.sql.transaction(async (tx) => {
      if (existingTxn?.status !== 'recovered') {
        await customersRepo.recordCustomerOutcome(tx, custId, {
          recovered: true,
          deltaLtvPaise: input.amountPaise,
        })
      }
    })
    return NOTHING_TO_DECIDE
  }

  // ── Reads and pure compute. No transaction open. ──────────────────────────────────
  const [features, risk] = await Promise.all([
    buildLiveFeatures(deps.sql, {
      customerId: input.customerId,
      transactionId: input.orderId,
      amountPaise: input.amountPaise,
      // An abandoned checkout has no declining bank, because no bank ever saw it.
      bank: null,
      retryIndex: chaseRounds,
      nowMs,
    }),
    buildLiveRiskSignals(deps.sql, {
      transactionId: input.orderId,
      customerId: input.customerId,
      // No card was charged, so there is no card id to key velocity on; the risk
      // signals fall back to the customer, which is their documented behaviour.
      cardId: null,
      amountPaise: input.amountPaise,
      nowMs,
    }),
  ])

  const capabilityAvailable = Object.fromEntries(
    CHECKOUT_SCENARIO.actions.map((a) => [a, true]),
  ) as Record<CheckoutAction, boolean>

  const decisionInput = {
    transactionId: input.orderId,
    eventId: input.eventId,
    nowMs,
    amount: paise(input.amountPaise),
    features,
    risk: { ...risk },
    shockSuppressed: false,
    optedOut: input.optedOut ?? false,
    capabilityAvailable,
    retryCount: chaseRounds,
    contactsLast7d: features.contacts_last_7d,
    expectedLtv: paise(input.amountPaise),
  }

  const decision = decide(decisionInput, CHECKOUT_DEFAULT_POLICY, CHECKOUT_SCENARIO)
  const chosen = decision.breakdown.find((b) => b.action === decision.chosenAction)
  const idempotencyKey = idempotencyKeyFor(input.eventId, decision.chosenAction)

  // ── Settle. One transaction, atomic — same contract as T4 on the Razorpay path. ───
  let escalationId: string | null = null
  await deps.sql.transaction(async (tx) => {
    await actionAttemptsRepo.createIntent(tx, {
      transactionId: txnId,
      eventId: evtId,
      action: decision.chosenAction,
      attemptGeneration: 1,
      idempotencyKey,
      // Abandonment decisions never execute a live payments call in this build: the
      // action is recorded as intent, exactly as a batch replay is.
      executionMode: 'dry_run',
      requestBody: { action: decision.chosenAction, amountPaise: input.amountPaise },
    })

    await recoveryAuditRepo.insertAuditRow(tx, {
      eventId: evtId,
      attemptGeneration: 1,
      transactionId: txnId,
      batchId: null,
      decisionInput: decisionInput as unknown as Jsonish,
      pRecover: chosen?.pRecover ?? null,
      riskScore: decision.riskScore,
      evBreakdown: decision.breakdown as unknown as Jsonish,
      chosenAction: decision.chosenAction,
      rationale: null,
      evMilli: decision.ev,
      upliftMilli: decision.uplift,
      llmSource: null,
      llmPromptTokens: null,
      llmCompletionTokens: null,
      llmCostMilli: null,
      decisionLatencyMs: deps.clock.nowMs() - nowMs,
      executionMode: 'dry_run',
      outcome: 'pending',
      reconciliationRequired: false,
    })

    // An escalated cart goes to the same operator queue as everything else, rather
    // than to a second one that would need its own triage.
    if (decision.chosenAction === CHECKOUT_SCENARIO.escalationAction) {
      const reason = classifyEscalation({
        riskGated: decision.riskGated,
        stoppingRuleHit: chaseRounds >= CHECKOUT_DEFAULT_POLICY.maxRetries,
      })
      const escalation = await escalationsRepo.createEscalation(tx, {
        eventId: evtId,
        attemptGeneration: 1,
        transactionId: txnId,
        customerId: custId,
        amountPaise: input.amountPaise,
        reason,
        riskScore: decision.riskScore,
        rationale: `Abandoned checkout, ${input.minutesSinceCreated}m unpaid (order ${input.orderStatus})`,
        slaDueAtMs: slaDueAtMs(nowMs, reason),
      })
      escalationId = escalation.id
    }

    // Counts a chase, not a charge attempt — the cap-safe atomic statement that closed
    // the real race in docs/INCIDENTS.md, reused rather than reimplemented.
    if (decision.chosenAction !== CHECKOUT_SCENARIO.nullAction) {
      await transactionsRepo.incrementRetryCount(tx, txnId, CHECKOUT_DEFAULT_POLICY.maxRetries)
    }
  })

  return {
    duplicate: false,
    chosenAction: decision.chosenAction,
    pRecover: chosen?.pRecover ?? null,
    evMilli: decision.ev,
    upliftMilli: decision.uplift,
    riskGated: decision.riskGated,
    escalationId,
  }
}
