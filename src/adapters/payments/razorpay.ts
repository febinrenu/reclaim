/**
 * The real Razorpay payments adapter, over the Payment Links REST API
 * (https://razorpay.com/docs/api/payments/payment-links/). Basic-auth'd with
 * `key_id:key_secret`, test mode only — src/config/env.ts refuses to boot with a
 * `rzp_live_` key before this file is ever reached.
 *
 * `req.transactionId` is written into `reference_id` at creation time specifically
 * so `findByReference` can look a link back up by it: BUILD_PLAN.md §5.6's crash
 * matrix requires that reclaiming a `live` intent after a crash between T3 and T4
 * never blindly re-creates a Payment Link that may already exist, since test mode
 * caps a business at 30 total.
 */
import type { PaymentsPort, PaymentLinkRequest } from '@/ports/executor'
import type { Jsonish } from '@/domain/json'

const API_BASE = 'https://api.razorpay.com/v1'

export function createRazorpayPayments(keyId: string, keySecret: string): PaymentsPort {
  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`

  async function razorpayFetch(path: string, init: RequestInit): Promise<Jsonish> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: authHeader, 'Content-Type': 'application/json' },
    })
    const body = (await res.json()) as Jsonish
    if (!res.ok) {
      const description =
        body !== null && typeof body === 'object' && 'error' in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${res.status}`
      throw new Error(`Razorpay API error: ${description}`)
    }
    return body
  }

  return {
    name: 'razorpay',

    async createPaymentLink(req: PaymentLinkRequest) {
      const body = await razorpayFetch('/payment_links', {
        method: 'POST',
        body: JSON.stringify({
          amount: req.amountPaise,
          currency: 'INR',
          reference_id: req.transactionId,
          description: `Reclaim payment recovery — ${req.transactionId}`,
          customer: req.customerId === null ? undefined : { contact: req.customerId },
          notify: { sms: false, email: false },
        }),
      })
      const record = body as { id: string; short_url: string }
      return { id: record.id, shortUrl: record.short_url }
    },

    async findByReference(idempotencyKey: string): Promise<Jsonish | null> {
      const body = await razorpayFetch(
        `/payment_links?reference_id=${encodeURIComponent(idempotencyKey)}`,
        { method: 'GET' },
      )
      const items = (body as { items?: readonly Jsonish[] }).items ?? []
      return items[0] ?? null
    },
  }
}
