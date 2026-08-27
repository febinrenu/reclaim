/**
 * Real risk signals for the live decision path — closes the D11 TODO left in
 * `process-event.ts` ("real risk signals need card-fingerprint tracking, not
 * built for the live path yet"). Three of the four `RiskInput` signals
 * (SYSTEM_SPEC.md §11) are genuinely computed from transaction history now,
 * strictly backward-looking as of the event instant (BUILD_PLAN.md §6.7's
 * leakage discipline — every query here filters `created_at < beforeMs`,
 * never touching this row's own insert or anything later).
 *
 * **`geoMismatch` stays permanently `false`, not a TODO.** A real Razorpay
 * webhook payment entity carries no billing/shipping geography field this
 * build has found a defensible way to read — `src/domain/webhooks/envelope.ts`
 * extracts exactly what the entity actually carries, and geography is not
 * among it. Stated as a fact about the data available, the same honest
 * scoping this project applies everywhere else (see `live-features.ts`'s own
 * docstring for the same treatment of `amount_zscore`/`ltv_zscore`/etc.).
 */
import type { SqlExecutor } from '@/ports/sql'
import { transactionId, customerId, type TransactionId } from '@/domain/ids'
import * as transactionsRepo from '@/repositories/transactions.repo'
import type { RiskInput } from '@/domain/risk/rules'

const VELOCITY_WINDOW_MS = 30 * 60 * 1000 // 30 minutes
const VELOCITY_THRESHOLD = 3 // >= 3 other failures on the same card/customer in the window
const FIRST_SEEN_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours
const AMOUNT_FAR_ABOVE_MULTIPLE = 3 // > 3x this customer's own historical average

export interface LiveRiskSignalsInput {
  readonly transactionId: string
  readonly customerId: string | null
  readonly cardId: string | null
  readonly amountPaise: number
  readonly nowMs: number
}

/** `cardId ?? customerId` is the risk-identity key throughout: a non-card
 * payment method (netbanking, UPI) still has a meaningful "same payer,
 * repeated failures" identity even without a card fingerprint. `null` when
 * neither is present — signals default to `false` rather than guessing.
 * Returns which column that key actually lives in, since `card_id` and
 * `customer_id` are two different columns a query must search correctly
 * rather than guess. */
function riskIdentity(
  input: LiveRiskSignalsInput,
): { readonly column: transactionsRepo.RiskIdentityColumn; readonly key: string } | null {
  if (input.cardId !== null) return { column: 'card_id', key: input.cardId }
  if (input.customerId !== null) return { column: 'customer_id', key: input.customerId }
  return null
}

export async function buildLiveRiskSignals(
  sql: SqlExecutor,
  input: LiveRiskSignalsInput,
): Promise<RiskInput> {
  const identity = riskIdentity(input)
  const txnId: TransactionId = transactionId(input.transactionId)

  if (identity === null) {
    return { geoMismatch: false, cardVelocityHigh: false, amountFarAboveHistory: false, cardFirstSeenRecently: false }
  }

  // Scoped to 'subscription': this function is only ever called from the
  // subscription live path (B2B's own risk signals are built separately, in
  // b2b-live-features.ts, with windows/thresholds actually suited to
  // invoices rather than card fraud velocity) — but both scenarios' rows
  // share this same `transactions` table, so an unscoped query here could
  // mix a customer's B2B invoice history into their subscription risk score
  // once B2B starts writing real rows.
  const [recentFailedCount, earliestMs, amountStats] = await Promise.all([
    transactionsRepo.countRecentFailedByIdentity(
      sql, identity.column, identity.key, txnId, input.nowMs - VELOCITY_WINDOW_MS, input.nowMs, 'subscription',
    ),
    transactionsRepo.earliestTransactionMsByIdentity(sql, identity.column, identity.key, txnId, input.nowMs, 'subscription'),
    input.customerId !== null
      ? transactionsRepo.customerAmountStats(sql, customerId(input.customerId), txnId, input.nowMs, 'subscription')
      : Promise.resolve(null),
  ])

  const cardVelocityHigh = recentFailedCount >= VELOCITY_THRESHOLD
  // No prior sighting before this instant (`earliestMs === null`) is itself
  // "first seen right now," the same as a sighting that happened moments ago —
  // both mean this identity has no track record yet.
  const cardFirstSeenRecently = earliestMs === null || input.nowMs - earliestMs < FIRST_SEEN_WINDOW_MS
  const amountFarAboveHistory =
    amountStats !== null && amountStats.mean > 0 && input.amountPaise > amountStats.mean * AMOUNT_FAR_ABOVE_MULTIPLE

  return {
    geoMismatch: false,
    cardVelocityHigh,
    amountFarAboveHistory,
    cardFirstSeenRecently,
  }
}
