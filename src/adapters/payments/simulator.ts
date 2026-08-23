/**
 * The payments simulator (BUILD_PLAN.md §4, §7): signs its own webhooks through
 * the identical HMAC path a genuine Razorpay delivery would use, and fakes Payment
 * Links. This is what makes the zero-credential demo real rather than mocked —
 * `scripts/replay.ts` posts events this adapter signs to the exact same
 * `/api/webhooks/razorpay` route a real Razorpay delivery would hit, so the
 * verification code path is never a special case for the demo.
 *
 * `resolveExecutionMode` (src/ports/executor.ts) never selects `live` when this
 * adapter is active — capabilities.ts reports `hasCredentials: false` for the
 * simulator by construction — so `createPaymentLink` here exists for completeness
 * and for a future demo of what a live link would have looked like, not because
 * the executor can ever reach it in the zero-credential path.
 */
import { computeWebhookSignature } from '@/domain/webhooks/verify-signature'
import type { PaymentsPort, PaymentLinkRequest } from '@/ports/executor'

export interface SimulatedSignedEvent {
  readonly rawBody: string
  readonly signature: string
}

export function createPaymentsSimulator(webhookSecret: string): PaymentsPort & {
  signEvent(payload: unknown): SimulatedSignedEvent
} {
  return {
    name: 'simulator',

    signEvent(payload: unknown): SimulatedSignedEvent {
      const rawBody = JSON.stringify(payload)
      return { rawBody, signature: computeWebhookSignature(rawBody, webhookSecret) }
    },

    async createPaymentLink(req: PaymentLinkRequest) {
      const id = `plink_sim_${req.transactionId}`
      return { id, shortUrl: `https://rzp.io/sim/${id}` }
    },

    // The simulator is never selected as 'live' (capabilities.ts reports
    // hasCredentials: false for it by construction), so this path is structurally
    // unreachable — returning null rather than throwing keeps the port's contract
    // uniform even for the branch that can never actually run.
    async findByReference() {
      return null
    },
  }
}
