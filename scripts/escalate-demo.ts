/**
 * `npm run escalate:demo` — drives one payment past the stopping rule so `/operator` has
 * real work items to show.
 *
 * Why this exists rather than reusing `npm run replay`: replay generates a FRESH payment
 * id per event (`pay_replay_<ts>_<i>`), which is correct for measuring latency across
 * independent events and useless here. `retry_count` lives on the transaction, so driving
 * it to the cap needs several deliveries for the SAME payment, with distinct event ids so
 * each one is a genuine new delivery rather than a duplicate the idempotency guard drops.
 *
 * The stopping rule is used deliberately in preference to the risk gate because it is
 * deterministic: once `retry_count >= policy.maxRetries`, `decide()` disallows every
 * action except escalation (`src/domain/decide.ts`'s `resolveAllowed`), so escalation is
 * not merely likely, it is the only allowed choice. That makes this a demo of the wiring
 * rather than a demo of the model's mood.
 *
 * The amount matters and is set small on purpose. A ₹40 human escalation only clears the
 * bar on a large enough amount, so at a large amount the policy escalates on event one and
 * `retry_count` never climbs. At ₹150 it chooses a retry action, the counter advances, and
 * the stopping rule fires the way a real exhausted transaction would.
 *
 * Everything goes through the real signed webhook path — same HMAC, same queue, same
 * worker a live Razorpay delivery hits. Nothing here reaches around the pipeline.
 */
import { loadEnv } from '../src/config/env'
import { DEV_WEBHOOK_SECRET } from '../src/config/capabilities'
import { computeWebhookSignature } from '../src/domain/webhooks/verify-signature'
import { SUBSCRIPTION_DEFAULT_POLICY } from '../src/domain/scenario/subscription'

interface CliArgs {
  readonly baseUrl: string
  readonly amountPaise: number
  /** How many payments to walk to exhaustion; each yields one work item. */
  readonly count: number
}

function parseArgs(argv: readonly string[]): CliArgs {
  let baseUrl = 'http://localhost:3000'
  let amountPaise = 150_00
  let count = 3
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url' && argv[i + 1] !== undefined) baseUrl = String(argv[++i])
    if (argv[i] === '--amount' && argv[i + 1] !== undefined) amountPaise = Number(argv[++i]) * 100
    if (argv[i] === '--count' && argv[i + 1] !== undefined) count = Number(argv[++i])
  }
  return { baseUrl, amountPaise, count }
}

/** One more delivery than the cap, so the last one lands with retries exhausted. */
const DELIVERIES_PER_PAYMENT = SUBSCRIPTION_DEFAULT_POLICY.maxRetries + 2

function envelope(paymentId: string, amountPaise: number, nowSec: number) {
  return {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: amountPaise,
          currency: 'INR',
          status: 'failed',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'escalation demo event',
          customer_id: `cust_${paymentId}`,
        },
      },
    },
    created_at: nowSec,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET
  const nowSec = Math.floor(Date.now() / 1000)

  let accepted = 0
  for (let p = 0; p < args.count; p++) {
    const paymentId = `pay_esc_${Date.now()}_${p}`
    for (let i = 0; i < DELIVERIES_PER_PAYMENT; i++) {
      const rawBody = JSON.stringify(envelope(paymentId, args.amountPaise, nowSec))
      const res = await fetch(`${args.baseUrl}/api/webhooks/razorpay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': computeWebhookSignature(rawBody, secret),
          'x-razorpay-event-id': `evt_esc_${paymentId}_${i}`,
        },
        body: rawBody,
      })
      await res.text()
      if (res.status === 202) accepted++
      // Deliveries for one payment must settle in order, or the later ones read a
      // stale retry_count and the counter never reaches the cap. The atomic capped
      // UPDATE keeps that SAFE under concurrency (docs/INCIDENTS.md); this pause is
      // about making the demo reproducible, not about correctness.
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
  }

  const total = args.count * DELIVERIES_PER_PAYMENT
  console.log(`posted ${accepted}/${total} deliveries across ${args.count} payment(s)`)
  console.log(
    `each payment received ${DELIVERIES_PER_PAYMENT} deliveries against a cap of ` +
      `${SUBSCRIPTION_DEFAULT_POLICY.maxRetries}, so the stopping rule should have fired`,
  )
  console.log(`open ${args.baseUrl}/operator — expect work items with reason "stopping_rule"`)

  if (accepted !== total) process.exitCode = 1
}

main().catch((err: unknown) => {
  process.stderr.write(`escalate-demo failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
