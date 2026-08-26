/**
 * Builds the subscription scenario's 13-feature vector from live database state,
 * for a real webhook-triggered decision. Strictly backward-looking, computed as of
 * `nowMs` — the same discipline `scripts/data/dgp.py`'s `Ledger` applies to the
 * synthetic generator (BUILD_PLAN.md §6.7).
 *
 * **What is real now, closed since this file's own original TODOs named them:**
 * `contacts_last_7d` (`action-attempts.repo.ts`'s `contactsInWindow`),
 * `bank_recent_fail_rate` (`transactions.repo.ts`'s `bankRecentFailRate`, once
 * `0008_bank_column.sql` gave the schema somewhere to read a bank from),
 * `amount_zscore` (per-customer when there's enough of their own history to
 * z-score against meaningfully, real global population otherwise — never a
 * fixed 0), and `ltv_zscore` (against the real, live customer population,
 * `customers.repo.ts`'s `ltvPopulationStats`, now that `recordCustomerOutcome`
 * is actually called — see `process-event.ts`'s T4 step; it existed since D3
 * and was never wired in, so every customer's LTV and success/failure
 * counters were silently stuck at zero regardless of real history).
 *
 * **Two features remain a deliberate, investigated simplification, not an
 * oversight — both are about a real-world mapping this project has explicitly
 * refused to assert without verification** (BUILD_PLAN.md §2.1 C10):
 * `is_soft_decline` / `is_insufficient_funds` are `scripts/data/common.py`'s
 * *synthetic* error taxonomy. Razorpay's own `error_reason` values for a
 * specific decline (as opposed to the three verified top-level `error_code`s —
 * `BAD_REQUEST_ERROR`, `GATEWAY_ERROR`, `SERVER_ERROR`) are not published as an
 * exhaustive, verifiable list this project could map against honestly. Default
 * to 0 (neither) rather than invent a mapping and assert it as real.
 */
import type { SqlExecutor } from '@/ports/sql'
import { customerId, transactionId, type TransactionId } from '@/domain/ids'
import * as customersRepo from '@/repositories/customers.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as actionAttemptsRepo from '@/repositories/action-attempts.repo'
import type { SharedFeature } from '@/domain/scenario/subscription-model'

const NO_BANK_HISTORY_PRIOR = 0.1
const NO_RECENT_FAILURE_DAYS = 180
const CONTACTS_WINDOW_DAYS = 7
const BANK_FAIL_RATE_WINDOW_DAYS = 30
/** Below this many of a customer's own prior transactions, their personal
 * amount distribution is too thin to z-score against meaningfully (a stddev
 * from 1-2 points is mostly noise) — fall back to the real global population
 * instead of a fixed 0, still a real number, just a broader one. */
const MIN_TXNS_FOR_PERSONAL_ZSCORE = 3

export interface LiveFactsInput {
  readonly customerId: string | null
  readonly transactionId: string
  readonly amountPaise: number
  readonly bank: string | null
  readonly retryIndex: number
  readonly nowMs: number
}

function zscore(value: number, mean: number, stddev: number): number {
  // A population of one (or all-identical values) has no real spread to
  // measure against — 0 (average) is the honest answer, not a divide-by-zero.
  return stddev === 0 ? 0 : (value - mean) / stddev
}

export async function buildLiveFeatures(
  sql: SqlExecutor,
  input: LiveFactsInput,
): Promise<Readonly<Record<SharedFeature, number>>> {
  const custId = input.customerId !== null ? customerId(input.customerId) : null
  const txnId = transactionId(input.transactionId)
  const customer = custId !== null ? await customersRepo.findCustomerById(sql, custId) : null

  const priorSuccessRate = customer === null
    ? 0.5
    : (customer.successfulPayments + customer.failedPayments) > 0
      ? customer.successfulPayments / (customer.successfulPayments + customer.failedPayments)
      : 0.5

  const customerTenureDays = customer === null
    ? 0
    : Math.max(0, (input.nowMs - customer.createdAt.getTime()) / 86_400_000)

  const daysSinceLastFailure = await daysSinceLastFailureFor(sql, input.transactionId, input.nowMs)

  const hourOfDayUtc = new Date(input.nowMs).getUTCHours()
  const hourAngle = (2 * Math.PI * hourOfDayUtc) / 24

  const contactsLast7d = custId === null
    ? 0
    : await actionAttemptsRepo.contactsInWindow(
        sql,
        custId,
        input.nowMs - CONTACTS_WINDOW_DAYS * 86_400_000,
        input.nowMs,
      )

  const bankFailRate = input.bank === null
    ? null
    : await transactionsRepo.bankRecentFailRate(
        sql,
        input.bank,
        input.nowMs - BANK_FAIL_RATE_WINDOW_DAYS * 86_400_000,
        input.nowMs,
      )

  const amountZscore = await computeAmountZscore(sql, custId, txnId, input.amountPaise, input.nowMs)
  const ltvZscore = customer === null ? 0 : await computeLtvZscore(sql, customer.ltvAmount)

  return {
    prior_success_rate: priorSuccessRate,
    days_since_last_failure: daysSinceLastFailure,
    amount_zscore: amountZscore,
    retry_count_so_far: input.retryIndex,
    is_recurring_subscription: 1,
    hour_sin: Math.sin(hourAngle),
    hour_cos: Math.cos(hourAngle),
    bank_recent_fail_rate: bankFailRate?.rate ?? NO_BANK_HISTORY_PRIOR,
    contacts_last_7d: contactsLast7d,
    ltv_zscore: ltvZscore,
    customer_tenure_days: customerTenureDays,
    is_soft_decline: 0,
    is_insufficient_funds: 0,
  }
}

async function computeAmountZscore(
  sql: SqlExecutor,
  custId: ReturnType<typeof customerId> | null,
  excludeTxnId: TransactionId,
  amountPaise: number,
  nowMs: number,
): Promise<number> {
  if (custId !== null) {
    const personal = await transactionsRepo.customerAmountStats(sql, custId, excludeTxnId, nowMs)
    if (personal !== null && personal.n >= MIN_TXNS_FOR_PERSONAL_ZSCORE) {
      return zscore(amountPaise, personal.mean, personal.stddev)
    }
  }
  const global = await transactionsRepo.globalAmountStats(sql, nowMs)
  if (global === null) return 0
  return zscore(amountPaise, global.mean, global.stddev)
}

async function computeLtvZscore(sql: SqlExecutor, customerLtvAmount: number): Promise<number> {
  const population = await customersRepo.ltvPopulationStats(sql)
  if (population === null) return 0
  return zscore(customerLtvAmount, population.mean, population.stddev)
}

/**
 * The transaction row's own `created_at` is set once, on first insert, and never
 * updated by later retries (see transactions.repo.ts's `upsertTransaction`) — so
 * for a transaction the app has already seen, that timestamp *is* the original
 * failure instant. A brand-new transaction has no prior failure on record at all.
 */
async function daysSinceLastFailureFor(
  sql: SqlExecutor,
  txnId: string,
  nowMs: number,
): Promise<number> {
  const existing = await transactionsRepo.findTransactionById(sql, transactionId(txnId))
  if (existing === null) return NO_RECENT_FAILURE_DAYS
  return Math.max(0, (nowMs - existing.createdAt.getTime()) / 86_400_000)
}

// Re-exported so callers building a transaction row do not need a second import
// just for the branded id constructor.
export { transactionId }
export type { TransactionId }
