/**
 * Real, live wiring for the B2B receivables scenario — closes `docs/adr/0007`'s
 * gap (see the ADR for the full rationale and this file's own "supersedes"
 * note). Unlike `process-event.ts`, there is no external webhook source to
 * react to: Razorpay has no invoice-overdue event, and no crash-injection
 * matrix drives this path (a single synchronous request/response, not a job
 * the embedded worker claims and can die mid-way through) — so this
 * deliberately does not replicate `process-event.ts`'s T1-T4 boundary
 * structure wholesale. What it does reuse, verbatim: `webhook_events` as the
 * idempotency authority (BUILD_PLAN.md §5.1 A1 — the exact mechanism
 * `schedule-followup.ts`'s own internally-generated events already rely on),
 * `decide()`/`computeEv`/`evaluateRisk` unmodified, and the same atomic,
 * cap-safe `incrementRetryCount` that closed the real retry-count race on the
 * subscription side (docs/INCIDENTS.md, 2026-08-27) — B2B's own
 * `chase_rounds_so_far` is exactly the same "read early, mutate atomically
 * later" shape, so it gets the same guard for free.
 */
import type { Deps } from '@/config/container'
import { createHash } from 'node:crypto'
import { eventId as toEventId, transactionId as toTransactionId, customerId as toCustomerId } from '@/domain/ids'
import { paise } from '@/domain/money'
import * as webhookEventsRepo from '@/repositories/webhook-events.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as customersRepo from '@/repositories/customers.repo'
import * as actionAttemptsRepo from '@/repositories/action-attempts.repo'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import { decide } from '@/domain/decide'
import { B2B_RECEIVABLE_SCENARIO, B2B_DEFAULT_POLICY, B2B_ACTIONS, type B2bAction } from '@/domain/scenario/b2b-receivable'
import { buildB2bLiveFeatures, buildB2bLiveRiskSignals } from '@/app/worker/b2b-live-features'
import { reserveEscalationSlot } from '@/app/worker/escalation-budget'
import { isQuietHoursIst, exceedsContactCap, capabilityRespectingCompliance } from '@/domain/compliance'

/** B2B's own contact window is 14 days (`contacts_last_14d`), not 7 — see
 * compliance.ts's own header for why this is a hard cap rather than a cost. */
const CONTACT_CAP_PER_14D = 4
import { executeAction } from '@/ports/executor'
import { redactFacts } from '@/language/redact-facts'
import { fillSlots } from '@/language/amount-slot'
import type { Tone, CopyResult } from '@/language/types'
import type { Jsonish } from '@/domain/json'

const ALL_CAPABLE: Readonly<Record<B2bAction, boolean>> = Object.fromEntries(
  B2B_ACTIONS.map((a) => [a, true]),
) as Record<B2bAction, boolean>

export class ProcessB2bEventError extends Error {}

export interface B2bInvoiceEventInput {
  readonly eventId: string
  readonly invoiceId: string
  readonly customerId: string
  readonly amountPaise: number
  readonly daysOverdue: number
  readonly billingAddressMismatch?: boolean | undefined
  readonly optedOut?: boolean | undefined
  /** A real payment against this invoice landed — mirrors
   * `process-event.ts`'s own `status === 'recovered'` short-circuit: nothing
   * left to decide once the debt is actually settled. */
  readonly paid?: boolean | undefined
}

export interface B2bInvoiceEventResult {
  readonly duplicate: boolean
  readonly chosenAction: B2bAction | 'PAID'
  readonly pRecover: number | null
  readonly evMilli: number | null
  readonly rationale: string | null
  readonly draftedMessage: string | null
  readonly chaseRoundsSoFar: number
  readonly reconciliationRequired: boolean
}

function idempotencyKeyFor(eventId: string, action: string): string {
  return createHash('sha256').update(`${eventId}|${action}|1`).digest('hex')
}

export async function processB2bInvoiceEvent(
  deps: Deps,
  input: B2bInvoiceEventInput,
): Promise<B2bInvoiceEventResult> {
  const nowMs = deps.clock.nowMs()
  const evtId = toEventId(input.eventId)
  const txnId = toTransactionId(input.invoiceId)
  const custId = toCustomerId(input.customerId)

  const inserted = await deps.sql.transaction((tx) =>
    webhookEventsRepo.insertIfAbsent(tx, {
      eventId: evtId,
      eventType: 'b2b.invoice_event',
      payload: { ...input } as unknown as Jsonish,
    }),
  )
  if (!inserted) {
    // Real redelivery of an already-processed event id — the same idempotency
    // guarantee webhook_events already gives the Razorpay path. Nothing new
    // to decide; the caller already got (or will get, from its own retried
    // request) the original result.
    return {
      duplicate: true,
      chosenAction: 'PAID',
      pRecover: null,
      evMilli: null,
      rationale: null,
      draftedMessage: null,
      chaseRoundsSoFar: 0,
      reconciliationRequired: false,
    }
  }

  await customersRepo.upsertCustomer(deps.sql, { id: custId })
  const existingTxn = await transactionsRepo.findTransactionById(deps.sql, txnId)
  const chaseRoundsSoFar = existingTxn?.retryCount ?? 0

  await transactionsRepo.upsertTransaction(deps.sql, {
    id: txnId,
    customerId: custId,
    amount: paise(input.amountPaise),
    status: input.paid === true ? 'recovered' : 'failed',
    scenario: 'b2b_receivable',
  })

  if (input.paid === true) {
    await deps.sql.transaction(async (tx) => {
      if (existingTxn?.status !== 'recovered') {
        await customersRepo.recordCustomerOutcome(tx, custId, { recovered: true, deltaLtvPaise: input.amountPaise })
      }
    })
    return {
      duplicate: false,
      chosenAction: 'PAID',
      pRecover: null,
      evMilli: null,
      rationale: null,
      draftedMessage: null,
      chaseRoundsSoFar,
      reconciliationRequired: false,
    }
  }

  // ── Reads and pure compute. No transaction open. ──────────────────────────
  const [features, risk] = await Promise.all([
    buildB2bLiveFeatures(deps.sql, {
      transactionId: input.invoiceId,
      customerId: input.customerId,
      amountPaise: input.amountPaise,
      daysOverdue: input.daysOverdue,
      chaseRoundsSoFar,
      billingAddressMismatch: input.billingAddressMismatch ?? false,
      nowMs,
    }),
    buildB2bLiveRiskSignals(deps.sql, {
      transactionId: input.invoiceId,
      customerId: input.customerId,
      amountPaise: input.amountPaise,
      daysOverdue: input.daysOverdue,
      chaseRoundsSoFar,
      billingAddressMismatch: input.billingAddressMismatch ?? false,
      nowMs,
    }),
  ])

  const contactBlocked =
    isQuietHoursIst(nowMs) || exceedsContactCap(features.contacts_last_14d, CONTACT_CAP_PER_14D)
  const capabilityAvailable = contactBlocked
    ? capabilityRespectingCompliance(B2B_RECEIVABLE_SCENARIO.actions, B2B_RECEIVABLE_SCENARIO.requiresContact, true)
    : ALL_CAPABLE

  let decisionInput = {
    transactionId: input.invoiceId,
    eventId: input.eventId,
    nowMs,
    amount: paise(input.amountPaise),
    retryCount: chaseRoundsSoFar,
    contactsLast7d: features.contacts_last_14d,
    expectedLtv: paise(0),
    features,
    risk,
    shockSuppressed: false,
    optedOut: input.optedOut ?? false,
    capabilityAvailable,
    escalationBudgetExhausted: false,
  }

  let decision = decide(decisionInput, B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
  if (decision.chosenAction === B2B_RECEIVABLE_SCENARIO.escalationAction) {
    const reserved = await reserveEscalationSlot(
      deps.kv,
      B2B_RECEIVABLE_SCENARIO.id,
      nowMs,
      B2B_DEFAULT_POLICY.escalationDailyBudget ?? deps.env.RECLAIM_ESCALATION_DAILY_BUDGET ?? null,
    )
    if (!reserved) {
      decisionInput = { ...decisionInput, escalationBudgetExhausted: true }
      decision = decide(decisionInput, B2B_DEFAULT_POLICY, B2B_RECEIVABLE_SCENARIO)
    }
  }
  const stoppingRuleHit = chaseRoundsSoFar >= B2B_DEFAULT_POLICY.maxRetries || decision.riskGated
  const idempotencyKey = idempotencyKeyFor(input.eventId, decision.chosenAction)

  // No live executor exists for any B2B action (docs/adr/0007 never built
  // one) — always dry_run, structurally, the same way a batch replay always
  // is on the subscription side (`resolveExecutionMode`).
  const executed = await executeAction(
    decision.chosenAction,
    'dry_run',
    { transactionId: input.invoiceId, amountPaise: input.amountPaise, customerId: input.customerId },
    deps.payments,
  )

  const nudge = await draftB2bNudgeIfNeeded(deps, decision.chosenAction, {
    invoiceId: input.invoiceId,
    amountPaise: input.amountPaise,
    daysOverdue: input.daysOverdue,
    chaseRoundsSoFar,
  })
  const draftedMessage = nudge?.message ?? null

  const rationale = deps.language.draftRationale({
    transactionId: input.invoiceId,
    action: decision.chosenAction,
    pRecoverPercent: (decision.breakdown.find((b) => b.action === decision.chosenAction)?.pRecover ?? 0) * 100,
    forcedEscalation: decision.riskGated,
    shockSuppressed: false,
  })

  const intent = await deps.sql.transaction((tx) =>
    actionAttemptsRepo.createIntent(tx, {
      transactionId: txnId,
      eventId: evtId,
      action: decision.chosenAction,
      attemptGeneration: 1,
      idempotencyKey,
      executionMode: 'dry_run',
      requestBody: { action: decision.chosenAction, amountPaise: input.amountPaise },
    }),
  )

  let racedPastCap = false
  let reconciliationRequired = false
  await deps.sql.transaction(async (tx) => {
    const isChaseAction = decision.chosenAction === 'SEND_REMINDER' || decision.chosenAction === 'OFFER_PAYMENT_PLAN'
    if (isChaseAction) {
      const result = await transactionsRepo.incrementRetryCount(tx, txnId, B2B_DEFAULT_POLICY.maxRetries)
      racedPastCap = !result.incremented
    }
    reconciliationRequired = racedPastCap

    await actionAttemptsRepo.settleIntent(tx, intent.id, {
      status: 'settled',
      result: draftedMessage === null ? executed.receipt : ({ draftedMessage } as Jsonish),
      reconciliationRequired,
    })
    await recoveryAuditRepo.insertAuditRow(tx, {
      eventId: evtId,
      attemptGeneration: 1,
      transactionId: txnId,
      decisionInput: decisionInput as unknown as Jsonish,
      pRecover: decision.breakdown.find((b) => b.action === decision.chosenAction)?.pRecover ?? null,
      riskScore: decision.riskScore,
      evBreakdown: decision.breakdown as unknown as Jsonish,
      chosenAction: decision.chosenAction,
      rationale,
      evMilli: decision.ev,
      upliftMilli: decision.uplift,
      llmSource: nudge?.copy.source ?? null,
      llmPromptTokens: nudge?.copy.promptTokens ?? null,
      llmCompletionTokens: nudge?.copy.completionTokens ?? null,
      llmCostMilli: nudge?.copy.costMilli ?? null,
      decisionLatencyMs: null,
      executionMode: 'dry_run',
      outcome: 'pending',
      reconciliationRequired,
    })

    const exhausted = stoppingRuleHit || racedPastCap
    if (exhausted && existingTxn?.status !== 'recovered') {
      await customersRepo.recordCustomerOutcome(tx, custId, { recovered: false, deltaLtvPaise: 0 })
    }
  })

  return {
    duplicate: false,
    chosenAction: decision.chosenAction,
    pRecover: decision.breakdown.find((b) => b.action === decision.chosenAction)?.pRecover ?? null,
    evMilli: decision.ev,
    rationale,
    draftedMessage,
    chaseRoundsSoFar,
    reconciliationRequired,
  }
}

async function draftB2bNudgeIfNeeded(
  deps: Deps,
  action: B2bAction,
  ctx: { readonly invoiceId: string; readonly amountPaise: number; readonly daysOverdue: number; readonly chaseRoundsSoFar: number },
): Promise<{ readonly message: string; readonly copy: CopyResult } | null> {
  if (action !== 'SEND_REMINDER' && action !== 'OFFER_PAYMENT_PLAN') return null

  const tone: Tone = ctx.chaseRoundsSoFar === 0 ? 'neutral' : 'empathetic'
  const facts = redactFacts({
    amountPaise: ctx.amountPaise,
    daysOverdue: ctx.daysOverdue,
    errorCode: null,
    retryCount: ctx.chaseRoundsSoFar,
    isRecurring: false,
  })

  const copyResult = await deps.language.draftNudge({
    transactionId: ctx.invoiceId,
    scenario: 'b2b_receivable',
    action,
    locale: 'en-IN',
    tone,
    facts,
  })

  // Defense in depth, not reliance on the prompt alone: SEND_REMINDER/
  // OFFER_PAYMENT_PLAN have no link concept, but generate-copy.ts's system
  // prompt is an instruction, not a guarantee — a real live request already
  // showed the model can include "{{link}}" anyway (docs/INCIDENTS.md). A
  // fallback value here means `fillSlots` always has something to fill it
  // with if that happens again; harmless when it doesn't, since
  // `fillLinkSlot` is a no-op on a message with no placeholder to replace.
  const message = fillSlots(copyResult.message, {
    amountPaise: ctx.amountPaise,
    link: 'reaching out to us directly to arrange payment',
  })
  return { message, copy: copyResult }
}
