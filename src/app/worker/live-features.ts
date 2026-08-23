/**
 * Builds the subscription scenario's 13-feature vector from live database state,
 * for a real webhook-triggered decision. Strictly backward-looking, computed as of
 * `nowMs` — the same discipline `scripts/data/dgp.py`'s `Ledger` applies to the
 * synthetic generator (BUILD_PLAN.md §6.7).
 *
 * **A known, deliberate simplification, not an oversight.** Three of the thirteen
 * features have no honest live-data source yet, and are defaulted rather than
 * guessed at:
 *
 *   - `bank_recent_fail_rate` — the D2 schema has no `bank` column on
 *     `transactions`, so there is nothing to compute a per-bank rolling rate
 *     from. Defaults to the same "no history yet" prior the generator's own
 *     `Ledger.bank_recent_fail_rate` uses for a bank it has never seen.
 *   - `is_soft_decline` / `is_insufficient_funds` — these are
 *     `scripts/data/common.py`'s *synthetic* error taxonomy, deliberately
 *     decoupled from Razorpay's real, unverified `error_reason` values
 *     (BUILD_PLAN.md §2.1 C10 refuses to assert an exhaustive real-world mapping).
 *     Default to 0 (neither) for a real error code until a defensible mapping
 *     exists.
 *   - `ltv_zscore` — z-scoring needs a population of customers to be relative to.
 *     A single live customer read in isolation has no such population yet.
 *     Defaults to 0 (average) until a real customer base exists to compute
 *     against.
 *
 * None of this affects D6's own exit test, which is about pipeline mechanics
 * (latency, exactly-once, crash recovery) rather than feature fidelity. Recorded
 * here, honestly, rather than silently shipped as if it were the real thing —
 * the same principle docs/INCIDENTS.md applies to a threshold that looks
 * finished but isn't.
 */
import type { SqlExecutor } from '@/ports/sql'
import { customerId, transactionId, type TransactionId } from '@/domain/ids'
import * as customersRepo from '@/repositories/customers.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import type { SharedFeature } from '@/domain/scenario/subscription-model'

const NO_BANK_HISTORY_PRIOR = 0.1
const NO_RECENT_FAILURE_DAYS = 180

export interface LiveFactsInput {
  readonly customerId: string | null
  readonly transactionId: string
  readonly amountPaise: number
  readonly retryIndex: number
  readonly nowMs: number
}

export async function buildLiveFeatures(
  sql: SqlExecutor,
  input: LiveFactsInput,
): Promise<Readonly<Record<SharedFeature, number>>> {
  const customer = input.customerId !== null ? await customersRepo.findCustomerById(sql, customerId(input.customerId)) : null

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

  return {
    prior_success_rate: priorSuccessRate,
    days_since_last_failure: daysSinceLastFailure,
    amount_zscore: 0, // no per-customer amount distribution to compare against yet
    retry_count_so_far: input.retryIndex,
    is_recurring_subscription: 1,
    hour_sin: Math.sin(hourAngle),
    hour_cos: Math.cos(hourAngle),
    bank_recent_fail_rate: NO_BANK_HISTORY_PRIOR,
    contacts_last_7d: 0, // TODO(D7+): count WHATSAPP_NUDGE/PAYMENT_LINK action_attempts in the trailing 7 days
    ltv_zscore: 0,
    customer_tenure_days: customerTenureDays,
    is_soft_decline: 0,
    is_insufficient_funds: 0,
  }
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
