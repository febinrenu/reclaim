/**
 * Builds the B2B receivables scenario's 9-feature vector and 4-field `RiskInput`
 * from live database state, for a real, live-reachable decision (`POST
 * /api/b2b/invoices`) — closes the gap `docs/adr/0007` named and deliberately
 * deferred: B2B was exercised through the policy simulator and offline
 * training/evaluation only, never a route a real request could reach.
 *
 * The honest scope of "live" here: unlike subscription's `payment.failed`/
 * `payment.captured`, there is no external event source for B2B receivables at
 * all — Razorpay has no invoice-overdue webhook, and this project has no
 * invoice-ledger schema of its own. So four of the nine features
 * (`days_overdue`, and the risk signal `geoMismatch` reinterpreted as
 * "billing-address mismatch") are real facts a caller's own accounts-
 * receivable system would know and must supply — exactly the same honesty
 * this project already applies to `geoMismatch` staying `false` on the
 * subscription side (`live-risk-signals.ts`'s own docstring): a fact this
 * codebase has no data source for is asked for explicitly, never invented.
 * Everything else — chase history, invoice-amount z-score, contact cadence,
 * relationship age, the cyclical quarter-position encoding — is computed live
 * from the same `transactions`/`customers`/`action_attempts` tables
 * subscription already uses, scoped to `scenario = 'b2b_receivable'` so the
 * two scenarios sharing one schema never pollute each other's history (see
 * `transactions.repo.ts`'s own `scenario` parameter doc comments).
 */
import type { SqlExecutor } from '@/ports/sql'
import { customerId, transactionId, type TransactionId } from '@/domain/ids'
import * as customersRepo from '@/repositories/customers.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as actionAttemptsRepo from '@/repositories/action-attempts.repo'
import type { RiskInput } from '@/domain/risk/rules'
import { B2B_DEFAULT_POLICY, type B2bFeature } from '@/domain/scenario/b2b-receivable'
import { zscore } from './live-features'

/** scripts/data_b2b/dgp.py's own rolling window, not a calendar quarter —
 * matched here so a live decision's `quarter_sin`/`quarter_cos` and
 * `is_repeat_overdue_this_quarter` mean the same thing the offline-trained
 * model was actually fit against. */
const QUARTER_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
const CONTACTS_WINDOW_DAYS = 14
/** Shorter and stricter than subscription's card-fraud velocity window (30
 * minutes, >= 3) — invoices from one customer arrive far less often, so 2
 * overdue invoices inside a week is already an unusual pattern worth flagging,
 * not routine volume. */
const INVOICE_VELOCITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const INVOICE_VELOCITY_THRESHOLD = 2
const NEW_RELATIONSHIP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const AMOUNT_FAR_ABOVE_MULTIPLE = 3
/** Mirrors subscription's own MIN_TXNS_FOR_PERSONAL_ZSCORE threshold — below
 * this many of a customer's own prior invoices, their personal average is too
 * thin to z-score against meaningfully; fall back to the population instead. */
const MIN_INVOICES_FOR_PERSONAL_ZSCORE = 3

export interface B2bLiveFactsInput {
  readonly transactionId: string
  readonly customerId: string
  readonly amountPaise: number
  readonly daysOverdue: number
  readonly chaseRoundsSoFar: number
  readonly billingAddressMismatch: boolean
  readonly nowMs: number
}

export async function buildB2bLiveFeatures(
  sql: SqlExecutor,
  input: B2bLiveFactsInput,
): Promise<Readonly<Record<B2bFeature, number>>> {
  const custId = customerId(input.customerId)
  const txnId: TransactionId = transactionId(input.transactionId)

  const [customer, personalStats, contactsLast14d, repeatOverdueCount] = await Promise.all([
    customersRepo.findCustomerById(sql, custId),
    transactionsRepo.customerAmountStats(sql, custId, txnId, input.nowMs, 'b2b_receivable'),
    actionAttemptsRepo.contactsInWindow(
      sql,
      input.customerId,
      input.nowMs - CONTACTS_WINDOW_DAYS * 86_400_000,
      input.nowMs,
      B2B_DEFAULT_POLICY.contactFatigueActions,
    ),
    transactionsRepo.countRecentFailedByIdentity(
      sql, 'customer_id', input.customerId, txnId, input.nowMs - QUARTER_WINDOW_MS, input.nowMs, 'b2b_receivable',
    ),
  ])

  const customerOntimeRate =
    customer === null
      ? 0.5
      : customer.successfulPayments + customer.failedPayments > 0
        ? customer.successfulPayments / (customer.successfulPayments + customer.failedPayments)
        : 0.5

  const customerRelationshipDays =
    customer === null ? 0 : Math.max(0, (input.nowMs - customer.createdAt.getTime()) / 86_400_000)

  let invoiceSizeZscore = 0
  if (personalStats !== null && personalStats.n >= MIN_INVOICES_FOR_PERSONAL_ZSCORE) {
    invoiceSizeZscore = zscore(input.amountPaise, personalStats.mean, personalStats.stddev)
  } else {
    const global = await transactionsRepo.globalAmountStats(sql, input.nowMs, 'b2b_receivable')
    if (global !== null) invoiceSizeZscore = zscore(input.amountPaise, global.mean, global.stddev)
  }

  const quarterProgress = (input.nowMs % QUARTER_WINDOW_MS) / QUARTER_WINDOW_MS
  const quarterAngle = 2 * Math.PI * quarterProgress

  return {
    days_overdue: input.daysOverdue,
    customer_ontime_rate: customerOntimeRate,
    invoice_size_zscore: invoiceSizeZscore,
    chase_rounds_so_far: input.chaseRoundsSoFar,
    is_repeat_overdue_this_quarter: repeatOverdueCount > 0 ? 1 : 0,
    quarter_sin: Math.sin(quarterAngle),
    quarter_cos: Math.cos(quarterAngle),
    contacts_last_14d: contactsLast14d,
    customer_relationship_days: customerRelationshipDays,
  }
}

export async function buildB2bLiveRiskSignals(sql: SqlExecutor, input: B2bLiveFactsInput): Promise<RiskInput> {
  const custId = customerId(input.customerId)
  const txnId: TransactionId = transactionId(input.transactionId)

  const [recentOverdueCount, earliestMs, amountStats] = await Promise.all([
    transactionsRepo.countRecentFailedByIdentity(
      sql,
      'customer_id',
      input.customerId,
      txnId,
      input.nowMs - INVOICE_VELOCITY_WINDOW_MS,
      input.nowMs,
      'b2b_receivable',
    ),
    transactionsRepo.earliestTransactionMsByIdentity(sql, 'customer_id', input.customerId, txnId, input.nowMs, 'b2b_receivable'),
    transactionsRepo.customerAmountStats(sql, custId, txnId, input.nowMs, 'b2b_receivable'),
  ])

  const cardVelocityHigh = recentOverdueCount >= INVOICE_VELOCITY_THRESHOLD
  const cardFirstSeenRecently = earliestMs === null || input.nowMs - earliestMs < NEW_RELATIONSHIP_WINDOW_MS
  const amountFarAboveHistory =
    amountStats !== null && amountStats.mean > 0 && input.amountPaise > amountStats.mean * AMOUNT_FAR_ABOVE_MULTIPLE

  return {
    geoMismatch: input.billingAddressMismatch,
    cardVelocityHigh,
    amountFarAboveHistory,
    cardFirstSeenRecently,
  }
}
