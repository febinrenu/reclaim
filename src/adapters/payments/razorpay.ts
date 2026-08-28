/**
 * The real Razorpay payments adapter, over the Payment Links REST API
 * (https://razorpay.com/docs/api/payments/payment-links/). Basic-auth'd with
 * `key_id:key_secret`, test mode only — src/config/env.ts refuses to boot with a
 * `rzp_live_` key before this file is ever reached.
 *
 * Notifications are OFF unless a consented recipient is configured
 * (`RECLAIM_NOTIFY_EMAIL` / `RECLAIM_NOTIFY_CONTACT`). The customers in every scenario
 * here are synthetic, so "notify the customer" would mean messaging a fabricated
 * address; this repository's constraints forbid unsolicited messages to real ones. An
 * operator-owned address is the only destination that is both real and consented, which
 * is what makes a delivery receipt worth anything.
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

/**
 * The one consented recipient real notifications may go to, or `null` for the default of
 * sending none. See `RECLAIM_NOTIFY_EMAIL` / `RECLAIM_NOTIFY_CONTACT` in src/config/env.ts
 * for why this is an operator-owned address rather than the customer's.
 */
export interface NotifyRecipient {
  readonly email: string | null
  readonly contact: string | null
}

export function createRazorpayPayments(
  keyId: string,
  keySecret: string,
  notify: NotifyRecipient | null = null,
): PaymentsPort {
  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
  const notifyEmail = notify?.email ?? null
  const notifyContact = notify?.contact ?? null
  const willNotify = notifyEmail !== null || notifyContact !== null

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
          // Deliberately NOT `{ contact: req.customerId }`, which is what this used to
          // send. `customerId` here is an internal identifier like `cust_batch_x_1`, not
          // a phone number — harmless while notifications were off, and precisely the
          // kind of thing that starts messaging a wrong or fabricated destination the
          // moment they are switched on. The only contact details this sends are the
          // consented ones, and only when they exist.
          ...(willNotify
            ? {
                customer: {
                  ...(notifyEmail === null ? {} : { email: notifyEmail }),
                  ...(notifyContact === null ? {} : { contact: notifyContact }),
                },
              }
            : {}),
          notify: { sms: notifyContact !== null, email: notifyEmail !== null },
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
