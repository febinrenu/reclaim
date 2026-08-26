/**
 * The worker's per-job pipeline (BUILD_PLAN.md §5.6): reads and pure compute with
 * no transaction open, T3 INTENT committed before any side effect, the executor
 * call with no transaction open, then T4 SETTLE atomically. `drainOnce` (./drain.ts)
 * calls this once per claimed job; T2 CLAIM happens there, not here.
 *
 * `RECLAIM_CRASH_AFTER=intent` exits the process immediately after T3 commits —
 * BUILD_PLAN.md §5.6's reproducible crash beat. The next `drainOnce` call (a fresh
 * process, in the demo) reclaims the same job, finds this function's own intent row
 * by idempotency key, and takes the reclaim branch below rather than recomputing
 * and re-intending from scratch.
 */
import { createHash } from 'node:crypto'
import type { Deps } from '@/config/container'
import type { JobRow } from '@/repositories/job-queue.repo'
import * as webhookEventsRepo from '@/repositories/webhook-events.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as customersRepo from '@/repositories/customers.repo'
import * as actionAttemptsRepo from '@/repositories/action-attempts.repo'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import * as jobQueueRepo from '@/repositories/job-queue.repo'
import * as batchesRepo from '@/repositories/batches.repo'
import { eventId as toEventId, transactionId as toTransactionId, customerId as toCustomerId } from '@/domain/ids'
import { paise } from '@/domain/money'
import { extractPrimaryEntity, extractFacts, WebhookEnvelopeSchema } from '@/domain/webhooks/envelope'
import { decide } from '@/domain/decide'
import {
  SUBSCRIPTION_SCENARIO,
  SUBSCRIPTION_DEFAULT_POLICY,
  SUBSCRIPTION_ACTIONS,
  type SubscriptionAction,
} from '@/domain/scenario/subscription'
import { resolveExecutionMode, executeAction, type ExecutionResult } from '@/ports/executor'
import { buildLiveFeatures } from './live-features'
import { buildLiveRiskSignals } from './live-risk-signals'
import { recordFailure, isShockSuppressed } from './shock-detector'
import { scheduleFollowupRetry } from './schedule-followup'
import { redactFacts } from '@/language/redact-facts'
import { fillSlots } from '@/language/amount-slot'
import type { CopyResult, Tone } from '@/language/types'
import type { Jsonish } from '@/domain/json'
import { mulberry32, hashSeed } from '@/domain/rng'

const ALL_CAPABLE: Readonly<Record<SubscriptionAction, boolean>> = Object.fromEntries(
  SUBSCRIPTION_ACTIONS.map((a) => [a, true]),
) as Record<SubscriptionAction, boolean>

/** SYSTEM_SPEC.md §14: risk_count>=3 or the risk gate forces escalation; otherwise
 * a `payment.failed`-family event is 'failed', a `*.captured`/`*.charged` event is
 * 'recovered'. Deliberately loose (an open string default, not an exhaustive
 * switch) per BUILD_PLAN.md C10's caution about Razorpay's own event vocabulary. */
function statusFromEvent(eventType: string): transactionsRepo.TransactionStatus {
  if (eventType.endsWith('.captured') || eventType.endsWith('.charged')) return 'recovered'
  return 'failed'
}

function idempotencyKeyFor(eventId: string, action: string, attemptGeneration: number): string {
  return createHash('sha256').update(`${eventId}|${action}|${attemptGeneration}`).digest('hex')
}

export class ProcessEventError extends Error {}

/** Postgres error code 23505 is `unique_violation`, on both drivers this project
 * uses (pglite is real Postgres compiled to WebAssembly, so its errors carry the
 * same `code` field node-pg does). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
}

export async function processEvent(deps: Deps, job: JobRow): Promise<void> {
  const t0 = Date.now()
  const payload = job.payload as { eventId?: unknown; batchId?: unknown; isFollowup?: unknown }
  if (typeof payload.eventId !== 'string') {
    throw new ProcessEventError(`process-event: job ${job.id} has no string eventId in its payload`)
  }
  const batchId = typeof payload.batchId === 'string' ? payload.batchId : null
  const isFollowup = payload.isFollowup === true
  const rawEventId = payload.eventId
  const evtId = toEventId(rawEventId)

  const webhookEvent = await webhookEventsRepo.findWebhookEvent(deps.sql, evtId)
  if (webhookEvent === null) {
    throw new ProcessEventError(`process-event: no webhook_events row for ${payload.eventId}`)
  }

  const envelope = WebhookEnvelopeSchema.parse(webhookEvent.payload)
  const primary = extractPrimaryEntity(envelope)
  if (primary === null) {
    throw new ProcessEventError(`process-event: envelope has no entity for ${payload.eventId}`)
  }
  const facts = extractFacts(primary.entity)
  if (facts.id === null || facts.amountPaise === null) {
    throw new ProcessEventError(`process-event: entity missing id or amount for ${payload.eventId}`)
  }

  const txnId = toTransactionId(facts.id)
  const custId = facts.customerId !== null ? toCustomerId(facts.customerId) : null
  const nowMs = deps.clock.nowMs()
  // Narrowed once here, not read as `facts.amountPaise` again inside the T4
  // closure below — narrowing from the guard above does not persist into a
  // nested function (the same reason `rawEventId` exists as its own const).
  const amountPaise = facts.amountPaise

  if (custId !== null) {
    await customersRepo.upsertCustomer(deps.sql, { id: custId })
  }

  const existingTxn = await transactionsRepo.findTransactionById(deps.sql, txnId)

  // A scheduled follow-up (see schedule-followup.ts) always carries a hardcoded
  // 'payment.failed' envelope, since it exists precisely because we didn't know
  // the outcome at schedule time. If a REAL captured/charged webhook resolved this
  // transaction in the meantime, the follow-up firing must never clobber that back
  // to 'failed' — this is the only case that check matters, so it is scoped to it.
  if (isFollowup && existingTxn?.status === 'recovered') {
    await deps.sql.transaction((tx) =>
      jobQueueRepo.complete(tx, job.id, { skipped: 'already recovered by a real webhook' }),
    )
    return
  }

  const retryIndex = existingTxn?.retryCount ?? 0
  const status = statusFromEvent(envelope.event)

  await transactionsRepo.upsertTransaction(deps.sql, {
    id: txnId,
    customerId: custId,
    amount: paise(facts.amountPaise),
    status,
    errorCode: facts.errorCode,
    errorDescription: facts.errorDescription,
    cardId: facts.cardId,
    bank: facts.bank,
  })

  // ── Reads and pure compute. No transaction open. ──────────────────────────
  const features = await buildLiveFeatures(deps.sql, {
    customerId: facts.customerId,
    transactionId: facts.id,
    amountPaise: facts.amountPaise,
    bank: facts.bank,
    retryIndex,
    nowMs,
  })

  const risk = await buildLiveRiskSignals(deps.sql, {
    transactionId: facts.id,
    customerId: facts.customerId,
    cardId: facts.cardId,
    amountPaise: facts.amountPaise,
    nowMs,
  })

  // The shock detector (SYSTEM_SPEC.md §15): record this event toward its
  // (bank, errorCode) rolling counter only if it is a genuine failure — a
  // successful payment carries no information about a degraded upstream — then
  // check suppression regardless of this event's own outcome, since suppression
  // reflects the shared upstream's state, not this one transaction's.
  if (status === 'failed') {
    await recordFailure(deps.kv, facts.bank, facts.errorCode)
  }
  const shockSuppressed = await isShockSuppressed(deps.kv, facts.bank, facts.errorCode)

  const decisionInput = {
    transactionId: facts.id,
    eventId: payload.eventId,
    nowMs,
    amount: paise(facts.amountPaise),
    retryCount: retryIndex,
    contactsLast7d: 0,
    expectedLtv: paise(0),
    features,
    // RiskInput is plain data but a named interface without an index
    // signature, so it doesn't structurally satisfy Jsonish the way an
    // inferred object literal does — same technicality as EvBreakdown below.
    risk: { ...risk },
    shockSuppressed,
    optedOut: false,
    capabilityAvailable: ALL_CAPABLE,
  }

  const decision = decide(decisionInput, SUBSCRIPTION_DEFAULT_POLICY, SUBSCRIPTION_SCENARIO)
  const decisionLatencyMs = Date.now() - t0
  // Mirrors decide()'s own internal formula (src/domain/decide.ts) exactly —
  // not re-exported from there to keep decide() pure and its return shape
  // unchanged; this is the same "no more retries will ever be scheduled for
  // this transaction from here" condition schedule-followup.ts already relies
  // on implicitly (it is only ever called when chosenAction is RETRY_NOW/
  // RETRY_LATER, which decide() cannot return once this is true).
  const stoppingRuleHit = retryIndex >= SUBSCRIPTION_DEFAULT_POLICY.maxRetries || decision.riskGated
  const attemptGeneration = 1
  const idempotencyKey = idempotencyKeyFor(payload.eventId, decision.chosenAction, attemptGeneration)

  const executorMode = resolveExecutionMode({
    source: batchId === null ? 'live_webhook' : 'batch_replay',
    hasCredentials: deps.capabilities.byPort('payments').live,
    configured: deps.env.EXECUTOR_MODE,
    liveBudgetRemaining: deps.env.EXECUTOR_LIVE_BUDGET,
  })

  const existingIntent = await actionAttemptsRepo.findByIdempotencyKey(deps.sql, idempotencyKey)
  const isReclaim = existingIntent !== null

  if (existingIntent !== null && existingIntent.status === 'settled') {
    // Reclaimed after a crash post-settle (RECLAIM_CRASH_AFTER=settle), or a
    // duplicate claim racing an already-done job. The audit row already exists;
    // only the job itself still needs completing.
    await deps.sql.transaction((tx) => jobQueueRepo.complete(tx, job.id, { alreadySettled: true }))
    return
  }

  const intent =
    existingIntent ??
    (await deps.sql.transaction((tx) =>
      actionAttemptsRepo.createIntent(tx, {
        transactionId: txnId,
        eventId: evtId,
        action: decision.chosenAction,
        attemptGeneration,
        idempotencyKey,
        executionMode: executorMode.mode,
        requestBody: { action: decision.chosenAction, amountPaise: facts.amountPaise },
      }),
    ))

  if (!isReclaim && deps.env.RECLAIM_CRASH_AFTER === 'intent') {
    deps.logger.warn({ event: 'crash_injection', point: 'intent', jobId: job.id }, 'RECLAIM_CRASH_AFTER=intent')
    process.exit(1)
  }

  // ── The language call and the executor call. Neither with a transaction open
  // (BUILD_PLAN.md §5.6: "never hold a database transaction across a network
  // call"). Order doesn't matter for correctness between these two — unlike the
  // executor, drafting copy has no side effect to reconcile — but the nudge
  // message wants the executor's receipt (a real payment-link URL, when one
  // exists) to fill its {{link}} slot, so the executor call runs first.
  const settlement = await settle(deps, intent.executionMode, isReclaim, decision.chosenAction, {
    transactionId: facts.id,
    amountPaise: facts.amountPaise,
    customerId: facts.customerId,
  }, idempotencyKey)

  const nudge = await draftNudgeIfNeeded(deps, decision.chosenAction, {
    transactionId: facts.id,
    amountPaise: facts.amountPaise,
    errorCode: facts.errorCode,
    retryIndex,
    linkUrl: extractLinkUrl(settlement.receipt),
    isDryRun: settlement.mode === 'dry_run',
  })

  const rationale = deps.language.draftRationale({
    transactionId: facts.id,
    action: settlement.forceEscalate ? SUBSCRIPTION_SCENARIO.escalationAction : decision.chosenAction,
    pRecoverPercent:
      (decision.breakdown.find((b) => b.action === decision.chosenAction)?.pRecover ?? 0) * 100,
    forcedEscalation: settlement.forceEscalate || decision.riskGated,
    shockSuppressed,
  })

  // A batch-runner (D9) event has no real payment gateway behind its dry_run
  // outcome ('pending', always — src/ports/executor.ts never resolves a
  // dry_run outcome to success/failed). For that source only, simulate a
  // ground-truth recovery outcome by drawing against the chosen action's own
  // calibrated P(recover) — a deterministic function of the event id
  // (`mulberry32(hashSeed(evtId))`, the same seeded-RNG pattern D4's generator
  // and the template engine already use), never a real payments-side effect.
  // The dashboard's naive-baseline comparison (src/app/batch/naive-baseline.ts)
  // recomputes this identically from the stored `ev_breakdown`, so the two stay
  // coupled under common random numbers without persisting the draw anywhere.
  const finalOutcome: SettlementResult['outcome'] =
    batchId === null
      ? settlement.outcome
      : mulberry32(hashSeed(evtId)).next() <
          (decision.breakdown.find((b) => b.action === decision.chosenAction)?.pRecover ?? 0)
        ? 'success'
        : 'failed'

  // ── T4 SETTLE. One transaction, atomic. ────────────────────────────────────
  try {
    await deps.sql.transaction(async (tx) => {
      await actionAttemptsRepo.settleIntent(tx, intent.id, {
        status: 'settled',
        result:
          nudge === null
            ? settlement.receipt
            : ({ ...(settlement.receipt as Record<string, Jsonish> | null), draftedMessage: nudge.message } as Jsonish),
        reconciliationRequired: settlement.reconciliationRequired,
      })
      await recoveryAuditRepo.insertAuditRow(tx, {
        eventId: evtId,
        attemptGeneration,
        transactionId: txnId,
        batchId,
        decisionInput,
        pRecover: decision.breakdown.find((b) => b.action === decision.chosenAction)?.pRecover ?? null,
        riskScore: decision.riskScore,
        // EvBreakdown is plain data (numbers, strings, booleans, null) but is a
        // named interface without an index signature, so it doesn't structurally
        // satisfy Jsonish the way an inferred object-literal type does — this cast
        // is a type-system technicality, not a loosening of what crosses the
        // boundary.
        evBreakdown: decision.breakdown as unknown as Jsonish,
        chosenAction: settlement.forceEscalate ? SUBSCRIPTION_SCENARIO.escalationAction : decision.chosenAction,
        rationale,
        evMilli: decision.ev,
        upliftMilli: decision.uplift,
        llmSource: nudge?.copy.source ?? null,
        llmPromptTokens: nudge?.copy.promptTokens ?? null,
        llmCompletionTokens: nudge?.copy.completionTokens ?? null,
        llmCostMilli: nudge?.copy.costMilli ?? null,
        decisionLatencyMs,
        executionMode: settlement.mode,
        outcome: finalOutcome,
      })
      if (finalOutcome === 'success') {
        await transactionsRepo.updateTransactionStatus(tx, txnId, 'recovered')
      }
      // A real, previously-undiscovered gap, closed here: `recordCustomerOutcome`
      // (customers.repo.ts) existed since D3, fully real, and was never called —
      // every customer's `successful_payments`/`failed_payments`/`ltv_amount_paise`
      // were silently stuck at zero regardless of real history, which meant
      // `prior_success_rate` in live-features.ts always fell through to its 0.5
      // default too, even though it looked wired up. Recorded exactly once per
      // transaction, on whichever event first makes its outcome final — recovery
      // (`status === 'recovered'`, the real webhook signal, or `finalOutcome ===
      // 'success'` for a batch-replay's synthetic draw), or the stopping rule
      // exhausting retries (no further RETRY_NOW/RETRY_LATER, hence no further
      // scheduled follow-up, will ever fire for this transaction again — see
      // schedule-followup.ts). `existingTxn` (read before this event touched
      // anything) is what makes "first time" checkable: a transaction already
      // `'recovered'` before this event was already counted.
      const wasAlreadyTerminal = existingTxn?.status === 'recovered'
      const recoveredNow = status === 'recovered' || finalOutcome === 'success'
      if (custId !== null && !wasAlreadyTerminal) {
        if (recoveredNow) {
          await customersRepo.recordCustomerOutcome(tx, custId, {
            recovered: true,
            deltaLtvPaise: amountPaise,
          })
        } else if (stoppingRuleHit) {
          await customersRepo.recordCustomerOutcome(tx, custId, { recovered: false, deltaLtvPaise: 0 })
        }
      }
      // SYSTEM_SPEC.md §14's stopping rule ("at most 3 automated attempts,"
      // enforced in decide() via retryCount >= policy.maxRetries) only has
      // anything real to compare against if an attempt actually gets counted.
      // A genuine D6-era gap, closed here: `incrementRetryCount` existed since
      // D2 but nothing ever called it, so the stopping rule could never
      // actually fire on the live path — see docs/INCIDENTS.md.
      if (decision.chosenAction === 'RETRY_NOW' || decision.chosenAction === 'RETRY_LATER') {
        await transactionsRepo.incrementRetryCount(tx, txnId, SUBSCRIPTION_DEFAULT_POLICY.maxRetries)
        // Only when we genuinely don't know the outcome yet. For a batch-replay
        // event finalOutcome is a real (synthetic) verdict — 'success' means this
        // transaction is already resolved, so scheduling a check-in on it would be
        // pointless. For a live webhook, executeAction never resolves RETRY_NOW/
        // RETRY_LATER past 'pending', so this is always true there — exactly the
        // case a follow-up exists to close.
        if (finalOutcome !== 'success') {
          await scheduleFollowupRetry({
            tx,
            originalEventId: rawEventId,
            nextRetryIndex: retryIndex + 1,
            nowMs,
            facts,
          })
        }
      }
      if (batchId !== null) {
        await batchesRepo.bumpBatchCounters(tx, batchId, { done: 1 })
      }
      await jobQueueRepo.complete(tx, job.id, { chosenAction: decision.chosenAction, outcome: finalOutcome })
    })
  } catch (err) {
    // recovery_audit UNIQUE (event_id, attempt_generation) makes two audit rows
    // for one event-generation structurally impossible (BUILD_PLAN.md §5.6) — a
    // concurrent settle of the same event-generation raises this constraint
    // rather than silently double-writing. Treat it as "already done," not a
    // failure: the row that won the race already has the audit trail.
    if (isUniqueViolation(err)) {
      await deps.sql.transaction((tx) => jobQueueRepo.complete(tx, job.id, { racedToSettle: true }))
      return
    }
    throw err
  }

  if (deps.env.RECLAIM_CRASH_AFTER === 'settle') {
    deps.logger.warn({ event: 'crash_injection', point: 'settle', jobId: job.id }, 'RECLAIM_CRASH_AFTER=settle')
    process.exit(1)
  }
}

interface SettlementResult {
  readonly mode: 'dry_run' | 'live'
  readonly outcome: 'success' | 'pending' | 'failed' | 'unknown'
  readonly receipt: ExecutionResult['receipt']
  readonly reconciliationRequired: boolean
  readonly forceEscalate: boolean
}

/**
 * BUILD_PLAN.md §5.6's crash matrix, "after T3, before T4" — the only genuinely
 * hard case. `isReclaim` means this intent already existed before this call, i.e.
 * a previous attempt got at least as far as T3 and then the process died before T4.
 */
async function settle(
  deps: Deps,
  mode: 'dry_run' | 'live',
  isReclaim: boolean,
  action: string,
  req: { readonly transactionId: string; readonly amountPaise: number; readonly customerId: string | null },
  idempotencyKey: string,
): Promise<SettlementResult> {
  if (mode === 'dry_run') {
    // No side effect could possibly have happened even on reclaim — safe to
    // discard whatever the prior attempt intended and simply redo it.
    const result = await executeAction(action, 'dry_run', req, deps.payments)
    return { mode, outcome: result.outcome, receipt: result.receipt, reconciliationRequired: false, forceEscalate: false }
  }

  if (!isReclaim) {
    const result = await executeAction(action, 'live', req, deps.payments)
    return { mode, outcome: result.outcome, receipt: result.receipt, reconciliationRequired: false, forceEscalate: false }
  }

  // Live and reclaimed: never blindly re-execute. Look for the real receipt.
  const found = await deps.payments.findByReference(idempotencyKey)
  if (found !== null) {
    return { mode, outcome: 'success', receipt: found, reconciliationRequired: false, forceEscalate: false }
  }
  return { mode, outcome: 'unknown', receipt: null, reconciliationRequired: true, forceEscalate: true }
}

function extractLinkUrl(receipt: Jsonish | null): string | null {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return null
  const url = (receipt as { readonly [key: string]: Jsonish }).shortUrl
  return typeof url === 'string' ? url : null
}

/**
 * Only the two contact-requiring actions ever get customer-facing copy
 * (`SUBSCRIPTION_SCENARIO.requiresContact`) — every other action is either
 * silent or routes to a human, never to a drafted message. Retry index doubles
 * as a coarse tone signal: a first nudge reads neutral, a second reads more
 * empathetic, a third (the last before the retry limit forces escalation)
 * reads more urgent.
 */
async function draftNudgeIfNeeded(
  deps: Deps,
  action: string,
  ctx: {
    readonly transactionId: string
    readonly amountPaise: number
    readonly errorCode: string | null
    readonly retryIndex: number
    readonly linkUrl: string | null
    readonly isDryRun: boolean
  },
): Promise<{ readonly message: string; readonly copy: CopyResult } | null> {
  if (action !== 'WHATSAPP_NUDGE' && action !== 'PAYMENT_LINK') return null

  const tone: Tone = ctx.retryIndex === 0 ? 'neutral' : ctx.retryIndex === 1 ? 'empathetic' : 'urgent'
  const facts = redactFacts({
    amountPaise: ctx.amountPaise,
    daysOverdue: 0, // TODO(D6+): real overdue tracking — see live-features.ts's own TODOs
    errorCode: ctx.errorCode,
    retryCount: ctx.retryIndex,
    isRecurring: true,
  })

  const copyResult = await deps.language.draftNudge({
    transactionId: ctx.transactionId,
    scenario: 'subscription',
    action,
    locale: 'en-IN',
    tone,
    facts,
  })

  const link =
    ctx.linkUrl ?? (ctx.isDryRun ? 'a secure payment link (dry run — nothing was actually sent)' : undefined)
  const message = fillSlots(copyResult.message, {
    amountPaise: ctx.amountPaise,
    ...(link !== undefined ? { link } : {}),
  })
  return { message, copy: copyResult }
}
