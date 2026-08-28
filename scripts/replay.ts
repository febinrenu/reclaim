/**
 * `npm run replay -- --n 50` (BUILD_PLAN.md §5, D6 exit test, and SYSTEM_SPEC.md
 * §9's "synthetic, signed, batch replay"). Generates N synthetic `payment.failed`
 * events, signs each through the identical HMAC path a genuine Razorpay delivery
 * uses (the payments simulator, never a shortcut), POSTs them at the real running
 * server's `/api/webhooks/razorpay`, and reports three separate latencies, each
 * labelled for what it actually measures:
 *
 *   1. ACK (T1, in-request)   the webhook route's own HTTP response time. This is the
 *                             number that has to fit inside Razorpay's 5-second
 *                             requirement, because it is the only part of the pipeline
 *                             in the request/response cycle. It is NOT the decision.
 *   2. DECISION (worker)      job pickup -> action chosen, as measured inside the
 *                             worker itself and stored on every `recovery_audit` row
 *                             (`decision_latency_ms`). Read back here rather than
 *                             timed from outside, so there is no polling resolution
 *                             error in it.
 *   3. END-TO-END (wall)      first POST -> the Nth audit row existing, from this
 *                             script's own clock. Includes queue wait and worker
 *                             poll interval, so it is a drain time for the whole
 *                             batch, not a per-event figure.
 *
 * This distinction used to be blurred: the README quoted (1) under the label
 * "webhook received -> action chosen", which is (2)'s description. The route responds
 * 202 before anything is decided — that is the whole point of the architecture — so
 * one number could never have been both.
 *
 * Deliberately talks to the server over HTTP for everything, including checking
 * whether the worker has drained (via `/api/dev/audit-count`) — this script never
 * opens its own database connection. PGlite is a single-process embedded database;
 * a second process opening the same data directory while `next dev` already holds
 * it open risks corrupting it rather than queuing politely the way a real Postgres
 * server would. The webhook secret is computed from the environment directly,
 * which needs no database at all.
 *
 * Default concurrency is 1, deliberately: a real Razorpay webhook consumer
 * receives deliveries one at a time, not as a simultaneous burst, and that is the
 * scenario the route's own p95 budget (BUILD_PLAN.md §5.5: under 120ms, hard
 * budget 800ms) is about. Measured sequentially against a production build on the
 * zero-credential path (embedded PGlite), ack p50/p95 land around 36ms/69ms and the
 * worker's own decision around 16ms/32ms — comfortably inside budget. Against a
 * REMOTE Postgres the picture changes completely: a real Supabase over a home
 * connection measured ack p50 ~1.9s, because every query in the route is a network
 * round trip. That is database locality, not this pipeline's logic; docs/LOAD_TEST.md
 * has the account.
 * Raising `--concurrency` is useful for its own sake (it is what
 * `tests/integration/webhook-worker.test.ts`'s duplicate-delivery race actually
 * tests, for correctness rather than latency), but latency *does* grow under
 * heavy concurrency: PGlite has exactly one connection, so concurrent requests
 * queue behind it rather than parallelising, and even node-pg's default
 * connection-pool size becomes the bottleneck well before the route logic does.
 * That is a connection-pool sizing question, not a defect in this pipeline.
 */
import { loadEnv } from '../src/config/env'
import { DEV_WEBHOOK_SECRET } from '../src/config/capabilities'
import { computeWebhookSignature } from '../src/domain/webhooks/verify-signature'

interface CliArgs {
  readonly n: number
  readonly baseUrl: string
  readonly concurrency: number
}

function parseArgs(argv: readonly string[]): CliArgs {
  let n = 50
  let baseUrl = 'http://localhost:3000'
  let concurrency = 1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--n' && argv[i + 1] !== undefined) n = Number(argv[++i])
    if (argv[i] === '--base-url' && argv[i + 1] !== undefined) baseUrl = String(argv[++i])
    if (argv[i] === '--concurrency' && argv[i + 1] !== undefined) concurrency = Number(argv[++i])
  }
  return { n, baseUrl, concurrency }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx] ?? 0
}

function makeEvent(i: number, nowSec: number) {
  const paymentId = `pay_replay_${Date.now()}_${i}`
  return {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 100_00 + (i % 20) * 5_00,
          currency: 'INR',
          status: 'failed',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'synthetic replay event',
          customer_id: `cust_replay_${i % 10}`,
        },
      },
    },
    created_at: nowSec,
  }
}

async function postOne(baseUrl: string, rawBody: string, signature: string, eventId: string) {
  const start = performance.now()
  const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body: rawBody,
  })
  const elapsedMs = performance.now() - start
  await res.text() // drain the body so the connection can be reused
  return { status: res.status, elapsedMs }
}

async function runBatch<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  async function worker(): Promise<void> {
    while (index < items.length) {
      const item = items[index++]
      if (item !== undefined) await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

interface AuditProgress {
  readonly count: number
  /** The worker's own per-event decision measurement, for every row settled so far. */
  readonly decisionLatencyMs: readonly number[]
}

async function fetchAuditProgress(
  baseUrl: string,
  eventIds: readonly string[],
): Promise<AuditProgress> {
  const res = await fetch(`${baseUrl}/api/dev/audit-count?eventIds=${eventIds.join(',')}`)
  const body = (await res.json()) as Partial<AuditProgress>
  return { count: body.count ?? 0, decisionLatencyMs: body.decisionLatencyMs ?? [] }
}

/** p50/p95/max on one line, or a plain note when there is nothing to summarise. */
function summarise(label: string, values: readonly number[]): string {
  if (values.length === 0) return `${label}: no samples`
  const sorted = [...values].sort((a, b) => a - b)
  return (
    `${label}: p50 ${percentile(sorted, 0.5).toFixed(1)}ms  ` +
    `p95 ${percentile(sorted, 0.95).toFixed(1)}ms  ` +
    `max ${Math.max(...sorted).toFixed(1)}ms  (n=${sorted.length})`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET

  const nowSec = Math.floor(Date.now() / 1000)
  const events = Array.from({ length: args.n }, (_, i) => makeEvent(i, nowSec))
  const eventIds = events.map((e) => `evt_replay_${e.payload.payment.entity.id}`)

  const latencies: number[] = []
  const statuses: number[] = []

  // The end-to-end window opens before the first POST and closes when the last audit
  // row exists, so it genuinely covers everything: route, queue, worker, settle.
  const firstPostAt = performance.now()

  await runBatch(events, args.concurrency, async (event) => {
    const rawBody = JSON.stringify(event)
    const signature = computeWebhookSignature(rawBody, secret)
    const eventId = `evt_replay_${event.payload.payment.entity.id}`
    const { status, elapsedMs } = await postOne(args.baseUrl, rawBody, signature, eventId)
    latencies.push(elapsedMs)
    statuses.push(status)
  })

  const accepted = statuses.filter((s) => s === 202).length
  console.log(`replayed ${args.n} events -> ${accepted}/${args.n} accepted (202)`)
  console.log(summarise('ACK        (T1, in-request)   ', latencies))

  // Poll for the worker to drain rather than assuming a fixed sleep is enough.
  const deadline = Date.now() + 30_000
  let progress: AuditProgress = { count: 0, decisionLatencyMs: [] }
  while (Date.now() < deadline) {
    progress = await fetchAuditProgress(args.baseUrl, eventIds)
    if (progress.count >= args.n) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const endToEndMs = performance.now() - firstPostAt

  console.log(summarise('DECISION   (worker, stored)   ', progress.decisionLatencyMs))
  console.log(
    `END-TO-END (wall, whole batch): ${endToEndMs.toFixed(0)}ms for ${progress.count}/${args.n} ` +
      `audit rows (${(endToEndMs / Math.max(1, progress.count)).toFixed(1)}ms/event mean, ` +
      `includes queue wait and the worker's own poll interval)`,
  )

  if (accepted !== args.n || progress.count !== args.n) {
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`replay failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
