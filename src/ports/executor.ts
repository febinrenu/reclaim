/**
 * `resolveExecutionMode` — pure, unit-tested with a truth table (BUILD_PLAN.md
 * §5.3). Live execution requires ALL of: real payments credentials, an explicit
 * (not default) choice to go live, budget remaining, and a source that is not a
 * batch replay. A batch replay is therefore ALWAYS dry-run structurally, which is
 * exactly why a 300-event replay can never exhaust the 30-Payment-Link test-mode
 * cap — the guarantee does not depend on anyone remembering to check a flag.
 */
import type { Jsonish } from '@/domain/json'

export type ExecutionMode = 'dry_run' | 'live'
export type ExecutionSource = 'live_webhook' | 'batch_replay' | 'simulation'

export interface ResolveExecutionModeInput {
  readonly source: ExecutionSource
  readonly hasCredentials: boolean
  readonly configured: ExecutionMode | 'auto'
  readonly liveBudgetRemaining: number
}

export interface ResolveExecutionModeResult {
  readonly mode: ExecutionMode
  readonly reason: string
}

export function resolveExecutionMode(ctx: ResolveExecutionModeInput): ResolveExecutionModeResult {
  if (ctx.source === 'batch_replay') {
    return {
      mode: 'dry_run',
      reason: 'batch replays are always dry_run, structurally, regardless of credentials or configuration',
    }
  }
  if (!ctx.hasCredentials) {
    return { mode: 'dry_run', reason: 'no live payments credentials configured' }
  }
  if (ctx.configured === 'dry_run') {
    return { mode: 'dry_run', reason: 'EXECUTOR_MODE=dry_run' }
  }
  if (ctx.liveBudgetRemaining <= 0) {
    return { mode: 'dry_run', reason: 'live execution budget exhausted' }
  }
  // configured is 'live' or 'auto' here, credentials present, budget remaining.
  return {
    mode: 'live',
    reason: `credentials present, EXECUTOR_MODE=${ctx.configured}, budget remaining`,
  }
}

export type ExecutionOutcome = 'success' | 'pending' | 'failed' | 'unknown'

export interface ExecutionResult {
  readonly mode: ExecutionMode
  readonly outcome: ExecutionOutcome
  readonly requestBody: Jsonish
  readonly receipt: Jsonish | null
}

/**
 * The one payments-side call the executor ever makes for real. Everything else
 * (silent retries, a nudge, an escalation) has no Razorpay-side effect at all.
 * For WHATSAPP_NUDGE and ESCALATE_HUMAN, that's a stated scope cut — the
 * language layer (D7) drafts the message; nothing here sends it anywhere,
 * because building a real WhatsApp/SMS delivery integration is out of scope
 * for this submission. For RETRY_NOW/RETRY_LATER it's a different, investigated
 * claim, not a scope cut: docs/adr/0010 records that no safe live gateway call
 * exists for them at all, on any provider, without a tokenized recurring
 * mandate this project's one-time-payment webhook path doesn't have. `dry_run`
 * never calls `payments` at all, live or simulated.
 */
export interface PaymentLinkRequest {
  readonly transactionId: string
  readonly amountPaise: number
  readonly customerId: string | null
}

export interface PaymentsPort {
  readonly name: 'simulator' | 'razorpay'
  createPaymentLink(req: PaymentLinkRequest): Promise<{ readonly id: string; readonly shortUrl: string }>
  /**
   * The reconciliation lookup for the crash matrix's hardest case (BUILD_PLAN.md
   * §5.6): reclaiming a `live` intent after a crash between T3 and T4 must never
   * blindly re-execute a payments-side call that might already have gone through.
   * Returns the real receipt if one is found under this idempotency key, or
   * `null` if genuinely nothing happened — the caller settles `outcome='unknown'`
   * and flags `reconciliation_required` in that case, rather than guessing.
   */
  findByReference(idempotencyKey: string): Promise<Jsonish | null>
}

export async function executeAction(
  action: string,
  mode: ExecutionMode,
  req: PaymentLinkRequest,
  payments: PaymentsPort,
): Promise<ExecutionResult> {
  const requestBody: Jsonish = {
    action,
    transactionId: req.transactionId,
    amountPaise: req.amountPaise,
    customerId: req.customerId,
  }

  if (mode === 'dry_run') {
    return { mode, outcome: 'pending', requestBody, receipt: null }
  }

  if (action === 'PAYMENT_LINK') {
    const link = await payments.createPaymentLink(req)
    return { mode, outcome: 'pending', requestBody, receipt: { linkId: link.id, shortUrl: link.shortUrl } }
  }

  // RETRY_NOW/RETRY_LATER have no live payments-side call to make — investigated,
  // not assumed (docs/adr/0010): no card network or UPI rail lets a merchant
  // backend silently re-charge a customer without either a registered recurring
  // mandate (which this project's one-time payment.failed webhook path has no
  // token for) or a fresh customer-facing checkout, which is exactly what the
  // PAYMENT_LINK action already is. Their real substance is
  // schedule-followup.ts's real future re-evaluation, not a live gateway call.
  return { mode, outcome: 'pending', requestBody, receipt: null }
}
