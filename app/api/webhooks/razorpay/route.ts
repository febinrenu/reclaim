/**
 * The webhook route, ordered exactly per BUILD_PLAN.md §5.5. Nothing between the
 * raw-body read and the signature check does anything but that check — no parsing,
 * no persistence — because HMAC verification must run over the exact raw bytes
 * (`req.json()` would have already parsed and discarded them) and must be the
 * first thing that can reject a request.
 *
 * Target p95 under 120ms, hard budget 800ms, against Razorpay's 5-second ceiling.
 * Steps 3-5 (verify, parse, replay window, T1) live in
 * `src/app/webhook/ingest-razorpay-event.ts`, testable on their own without a
 * running Next.js server — this file is deliberately thin.
 */
import { headers } from 'next/headers'
import { after } from 'next/server'
import { getDeps } from '@/server/di'
import { ingestRazorpayEvent } from '@/app/webhook/ingest-razorpay-event'
import { drainOnce } from '@/app/worker/drain'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// HMAC verification stops a forged event from ever being trusted, but it does
// nothing to stop volumetric flooding of this public URL with well-formed or
// garbage POSTs before verification even runs. Limit is deliberately generous
// (Razorpay can legitimately burst several real deliveries — captures,
// refunds, retries — for one merchant within a second) and per-IP so one
// noisy source can't starve delivery from Razorpay's own real IPs sharing
// this route with everyone else. Not applied to signature/dedupe logic
// itself, which already has its own protection (src/app/webhook/ingest-razorpay-event.ts).
const WEBHOOK_RATE_LIMIT = 300
const WEBHOOK_RATE_WINDOW_SECONDS = 60

export async function POST(req: Request): Promise<Response> {
  // 1. Raw body, before anything else touches it.
  const rawBody = await req.text()

  // 2. Next 16: headers() is async.
  const hdrs = await headers()

  const deps = await getDeps()

  const rateLimit = await checkRateLimit(
    deps.kv,
    'webhook',
    clientKeyFrom(req),
    WEBHOOK_RATE_LIMIT,
    WEBHOOK_RATE_WINDOW_SECONDS,
  )
  if (!rateLimit.allowed) {
    return new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) },
    })
  }

  const result = await ingestRazorpayEvent(deps, {
    rawBody,
    signatureHeader: hdrs.get('x-razorpay-signature'),
    eventIdHeader: hdrs.get('x-razorpay-event-id'),
  })

  switch (result.kind) {
    case 'invalid_signature':
      return new Response('invalid signature', { status: 400 })
    case 'malformed_body':
      return new Response('malformed JSON body', { status: 400 })
    case 'invalid_envelope':
      return new Response('envelope failed validation', { status: 400 })
    case 'no_event_id':
      return new Response('no event id in header or body', { status: 400 })
    case 'replay_rejected':
      return new Response(`event rejected: ${result.reason}`, { status: 400 })
    case 'duplicate':
      // Razorpay stops retrying on any 2xx.
      return new Response('duplicate, ignored', { status: 200 })
    case 'accepted': {
      // 6. Non-blocking: fires after the response is sent. On `next dev`, the
      // embedded poller (instrumentation.ts) would pick this up within 250ms
      // anyway; this just shaves that off for a snappier demo without holding
      // the response open.
      //
      // Gated on the same flag as the embedded poller: the crash-recovery demo
      // needs a standalone `npm run worker` to be the *only* thing claiming jobs,
      // or which process lands the crash-designated job becomes a race — this
      // kick would otherwise almost always win it, since it fires within
      // milliseconds of the response versus the standalone worker's poll
      // interval. See src/config/env.ts's DISABLE_EMBEDDED_WORKER.
      if (!deps.env.DISABLE_EMBEDDED_WORKER) {
        after(() => {
          drainOnce(deps, { maxJobs: 10, budgetMs: 2000, workerId: 'webhook-after-kick' }).catch((err: unknown) => {
            deps.logger.error(
              { event: 'after_kick_failed', error: err instanceof Error ? err.message : String(err) },
              'post-response drain kick failed',
            )
          })
        })
      }
      // 7.
      return Response.json({ accepted: true, eventId: result.eventId, jobId: result.jobId }, { status: 202 })
    }
  }
}
