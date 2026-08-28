/**
 * `POST /api/checkout/abandoned` — runs one abandoned checkout through the real decision
 * engine, mirroring `POST /api/b2b/invoices` exactly rather than inventing a second shape.
 *
 * Deliberately a route rather than a webhook handler: Razorpay emits no abandonment event,
 * because abandonment is the *absence* of a payment rather than the presence of anything.
 * It has to be found by looking, which `scripts/sweep-abandoned-checkouts.ts` does against
 * the real Orders API before posting each unpaid order here.
 *
 * Rate-limited like every other unauthenticated route that does real work. Idempotency is
 * the caller's `eventId`, enforced by the same `webhook_events` UNIQUE constraint the
 * Razorpay path uses — so a sweep that runs twice over the same still-unpaid order decides
 * once.
 */
import { getDeps } from '@/server/di'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'
import { processAbandonedCheckout } from '@/app/checkout/process-abandoned-checkout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT = 60
const RATE_WINDOW_SECONDS = 300

interface Body {
  readonly eventId?: unknown
  readonly orderId?: unknown
  readonly customerId?: unknown
  readonly amountPaise?: unknown
  readonly minutesSinceCreated?: unknown
  readonly orderStatus?: unknown
  readonly optedOut?: unknown
  readonly paid?: unknown
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps()

  const rateLimit = await checkRateLimit(
    deps.kv,
    'checkout-abandoned',
    clientKeyFrom(req),
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  )
  if (!rateLimit.allowed) {
    return new Response('rate limit exceeded, try again shortly', {
      status: 429,
      headers: { 'retry-after': String(rateLimit.retryAfterSeconds) },
    })
  }

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return new Response('malformed JSON body', { status: 400 })
  }

  const eventId = nonEmpty(body.eventId)
  const orderId = nonEmpty(body.orderId)
  const customerId = nonEmpty(body.customerId)
  if (eventId === null || orderId === null || customerId === null) {
    return json({ error: 'eventId, orderId and customerId are required non-empty strings' }, 400)
  }

  const amountPaise = body.amountPaise
  if (typeof amountPaise !== 'number' || !Number.isInteger(amountPaise) || amountPaise <= 0) {
    return json({ error: 'amountPaise must be a positive integer (paise, never rupees)' }, 400)
  }

  const minutes = body.minutesSinceCreated
  if (minutes !== undefined && (typeof minutes !== 'number' || minutes < 0)) {
    return json({ error: 'minutesSinceCreated must be a non-negative number' }, 400)
  }

  const orderStatus = body.orderStatus
  if (orderStatus !== undefined && orderStatus !== 'created' && orderStatus !== 'attempted') {
    // Only these two mean "unpaid". A `paid` order is not an abandoned one, and letting
    // it through would put a converted cart into the recovery pipeline.
    return json({ error: "orderStatus must be 'created' or 'attempted'" }, 400)
  }

  const result = await processAbandonedCheckout(deps, {
    eventId,
    orderId,
    customerId,
    amountPaise,
    minutesSinceCreated: typeof minutes === 'number' ? minutes : 0,
    orderStatus: orderStatus ?? 'created',
    optedOut: body.optedOut === true,
    paid: body.paid === true,
  })

  return json(result)
}
