/**
 * The real Razorpay payments adapter. Not yet implemented — no live credentials
 * exist as of D6 (BUILD_PLAN.md §10.4, scheduled for the credential runbook).
 * Mirrors src/adapters/kv/upstash.ts's stance: `resolveExecutionMode`
 * (src/ports/executor.ts) already guarantees this can only be reached once
 * `PAYMENTS_DRIVER=razorpay` is genuinely selected, which itself requires
 * `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to be present — so throwing here
 * rather than silently degrading is the same "fail loud, not open" reasoning
 * docs/INCIDENTS.md's secret-guard incident is about.
 */
import type { PaymentsPort } from '@/ports/executor'

export function createRazorpayPayments(_keyId: string, _keySecret: string): PaymentsPort {
  return {
    name: 'razorpay',
    createPaymentLink() {
      throw new Error(
        'PAYMENTS_DRIVER=razorpay is selected but src/adapters/payments/razorpay.ts has no ' +
          'implementation yet. It lands with the credential runbook (BUILD_PLAN.md §10.4). ' +
          'Until then, unset RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET to use the simulator instead.',
      )
    },
    findByReference() {
      throw new Error(
        'PAYMENTS_DRIVER=razorpay is selected but src/adapters/payments/razorpay.ts has no ' +
          'implementation yet. See createPaymentLink above.',
      )
    },
  }
}
