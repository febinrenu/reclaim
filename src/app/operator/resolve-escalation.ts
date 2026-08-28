/**
 * Resolving an escalation, and the one thing that makes it worth more than a ticket
 * queue: the operator's answer is written back as a **real outcome**.
 *
 * Every label this project has evaluated against so far comes from its own generator —
 * `docs/EVALUATION.md` says so directly, and the customer-disjoint validation exists
 * because that limitation is real. A resolved escalation is different in kind. A human
 * looked at a specific failed payment, contacted a specific customer, and reported what
 * happened. That is the first label here that the DGP did not draw.
 *
 * So resolution does three things atomically:
 *   1. moves the work item to `resolved` (a conditional UPDATE — see the repo),
 *   2. sets the transaction's terminal status from what the human found,
 *   3. records the customer outcome, feeding `prior_success_rate` and `ltv_zscore` in
 *      `live-features.ts` from observed reality rather than a synthetic draw.
 *
 * `promised_to_pay` deliberately does NOT count as recovery (see
 * `isRecoveredResolution`). A promise is not money. If it is kept, a real
 * `payment.captured` webhook settles the transaction through the normal path and is
 * counted exactly once, there.
 */
import type { Transactional } from '@/ports/sql'
import * as escalationsRepo from '@/repositories/escalations.repo'
import * as transactionsRepo from '@/repositories/transactions.repo'
import * as customersRepo from '@/repositories/customers.repo'
import {
  isRecoveredResolution,
  isTerminalNegativeResolution,
  type EscalationResolution,
} from '@/domain/escalation'

export type ResolveOutcome =
  | { readonly ok: true; readonly escalation: escalationsRepo.EscalationRow }
  /** The item was not in `claimed` — already resolved, still open, or gone. */
  | { readonly ok: false; readonly reason: 'not_claimed' }

export interface ResolveEscalationInput {
  readonly id: string
  readonly resolution: EscalationResolution
  readonly note: string | null
  readonly nowMs: number
}

export async function resolveEscalationAndRecordOutcome(
  sql: Transactional,
  input: ResolveEscalationInput,
): Promise<ResolveOutcome> {
  return sql.transaction(async (tx) => {
    const resolved = await escalationsRepo.resolveEscalation(
      tx,
      input.id,
      input.resolution,
      input.note,
      input.nowMs,
    )
    // `null` means the conditional UPDATE matched nothing: the row was not `claimed`.
    // Reported rather than thrown — a second operator pressing Resolve on an item
    // someone else already closed is ordinary, not exceptional.
    if (resolved === null) return { ok: false, reason: 'not_claimed' }

    const recovered = isRecoveredResolution(input.resolution)

    if (resolved.transactionId !== null) {
      // 'escalated' is the honest resting state for `promised_to_pay`: a human is
      // involved and the money has not arrived. Only a real payment signal, or a
      // human saying it arrived, moves it off that.
      const status: transactionsRepo.TransactionStatus = recovered
        ? 'recovered'
        : isTerminalNegativeResolution(input.resolution)
          ? 'abandoned'
          : 'escalated'
      await transactionsRepo.updateTransactionStatus(tx, resolved.transactionId, status)
    }

    // Only on a terminal answer. `promised_to_pay` is explicitly not terminal, so it
    // must not write a customer outcome — doing so would either credit a recovery that
    // has not happened or bank a failure that may yet be a success, and the same
    // transaction would then be counted twice when the promise resolves for real.
    if (
      resolved.customerId !== null &&
      (recovered || isTerminalNegativeResolution(input.resolution))
    ) {
      await customersRepo.recordCustomerOutcome(tx, resolved.customerId, {
        recovered,
        deltaLtvPaise: recovered ? resolved.amountPaise : 0,
      })
    }

    return { ok: true, escalation: resolved }
  })
}
