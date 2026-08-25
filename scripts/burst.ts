/**
 * `npm run burst` (SYSTEM_SPEC.md §15, BUILD_PLAN.md's D11 exit test and §6.10's
 * "report detection latency, true trips and false trips as a three-row table").
 * Fires a correlated-failure burst sharing one (bank, errorCode) pair through the
 * real signed webhook path, plus the two decoys BUILD_PLAN.md §6.10 names by
 * number: a 12-event sub-threshold cluster, and a 35-event cluster sharing one
 * error code spread across 4 banks (proving key granularity is a choice, not an
 * accident — a per-bank key never trips on cross-bank noise).
 *
 * **What "flips behaviour mid-batch" means for real, on the trained model
 * currently shipped.** `RETRY_NOW`'s own dummy coefficient (-0.12) is dominated
 * by `RETRY_LATER`'s (+0.52) by a wide enough margin that RETRY_NOW is never the
 * argmax for *any* reachable feature state — confirmed both analytically (their
 * EV difference reduces to a fixed sign, independent of amount, since both cost
 * ₹0 to attempt) and empirically (200,000 random feature vectors, `pRETRY_NOW -
 * pRETRY_LATER` never once positive). So this burst does not show
 * `chosen_action` itself flipping from RETRY_NOW to RETRY_LATER — that would be
 * showing something the shipped model never does regardless of the shock
 * detector. What it shows instead, and what the detector's actual job is: every
 * decision still computes RETRY_NOW's own EV (SYSTEM_SPEC.md §11: the
 * counterfactual is always on the record), and that entry's `allowed` flag
 * flips from `true` to `false` with `disallowedReason: 'shock_suppressed'`
 * exactly at the trip point — the mechanism working exactly as designed, on the
 * actual code path, not a number massaged to fit an illustrative example.
 */
import { loadEnv } from '../src/config/env'
import { DEV_WEBHOOK_SECRET } from '../src/config/capabilities'
import { computeWebhookSignature } from '../src/domain/webhooks/verify-signature'

interface CliArgs {
  readonly baseUrl: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  let baseUrl = 'http://localhost:3000'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url' && argv[i + 1] !== undefined) baseUrl = String(argv[++i])
  }
  return { baseUrl }
}

function makeEvent(idSuffix: string, bank: string, errorCode: string, nowSec: number) {
  const paymentId = `pay_burst_${idSuffix}`
  return {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 150_00,
          currency: 'INR',
          status: 'failed',
          error_code: errorCode,
          error_description: 'synthetic burst event',
          customer_id: `cust_burst_${idSuffix}`,
          bank,
        },
      },
    },
    created_at: nowSec,
  }
}

async function postOne(baseUrl: string, secret: string, event: ReturnType<typeof makeEvent>, eventId: string) {
  const rawBody = JSON.stringify(event)
  const signature = computeWebhookSignature(rawBody, secret)
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
  await res.text()
  return { status: res.status, elapsedMs }
}

async function fireCluster(
  baseUrl: string,
  secret: string,
  label: string,
  events: readonly { readonly idSuffix: string; readonly bank: string; readonly errorCode: string }[],
): Promise<readonly string[]> {
  const nowSec = Math.floor(Date.now() / 1000)
  const eventIds: string[] = []
  for (const e of events) {
    const event = makeEvent(e.idSuffix, e.bank, e.errorCode, nowSec)
    const eventId = `evt_burst_${e.idSuffix}`
    eventIds.push(eventId)
    const { status } = await postOne(baseUrl, secret, event, eventId)
    if (status !== 202 && status !== 200) {
      process.stderr.write(`${label}: unexpected status ${status} for ${eventId}\n`)
    }
  }
  return eventIds
}

async function fetchAuditCount(baseUrl: string, eventIds: readonly string[]): Promise<number> {
  const res = await fetch(`${baseUrl}/api/dev/audit-count?eventIds=${eventIds.join(',')}`)
  const body = (await res.json()) as { count: number }
  return body.count
}

interface AuditActionRow {
  readonly eventId: string
  readonly chosenAction: string
  readonly rationale: string | null
  readonly createdAt: string
  readonly retryNow: { readonly allowed: boolean | null; readonly reason: string | null }
}

async function fetchAuditActions(baseUrl: string, eventIds: readonly string[]): Promise<readonly AuditActionRow[]> {
  const res = await fetch(`${baseUrl}/api/dev/audit-actions?eventIds=${eventIds.join(',')}`)
  const body = (await res.json()) as { rows: AuditActionRow[] }
  return body.rows
}

async function waitForDrain(baseUrl: string, eventIds: readonly string[], timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let count = 0
  while (Date.now() < deadline) {
    count = await fetchAuditCount(baseUrl, eventIds)
    if (count >= eventIds.length) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return count
}

interface DetectionRow {
  readonly cluster: string
  readonly events: number
  readonly tripped: boolean
  readonly detectionLatencyMs: number | null
  readonly trueTrips: number
  readonly falseTrips: number
}

function summarizeCluster(cluster: string, rows: readonly AuditActionRow[], expectedToTrip: boolean): DetectionRow {
  const tripIndex = rows.findIndex((r) => r.retryNow.reason === 'shock_suppressed')
  const tripped = tripIndex !== -1
  let detectionLatencyMs: number | null = null
  if (tripped) {
    const firstMs = new Date(rows[0]?.createdAt ?? rows[tripIndex]?.createdAt ?? 0).getTime()
    const tripMs = new Date(rows[tripIndex]?.createdAt ?? 0).getTime()
    detectionLatencyMs = tripMs - firstMs
  }
  return {
    cluster,
    events: rows.length,
    tripped,
    detectionLatencyMs,
    trueTrips: tripped && expectedToTrip ? 1 : 0,
    falseTrips: tripped && !expectedToTrip ? 1 : 0,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET
  const runId = Date.now()

  // The main burst: 35 correlated failures against one bank/error-code pair —
  // comfortably over SHOCK_THRESHOLD, "in quick succession" as SYSTEM_SPEC.md
  // §15 asks the demo to show.
  const mainBank = 'HDFC'
  const mainErrorCode = 'GATEWAY_ERROR'
  const mainEvents = Array.from({ length: 35 }, (_, i) => ({
    idSuffix: `${runId}_main_${i}`,
    bank: mainBank,
    errorCode: mainErrorCode,
  }))

  // Decoy 1: 12 events, same bank/error-code — must stay under SHOCK_THRESHOLD.
  const decoy1Events = Array.from({ length: 12 }, (_, i) => ({
    idSuffix: `${runId}_decoy1_${i}`,
    bank: 'AXIS',
    errorCode: 'BAD_REQUEST_ERROR',
  }))

  // Decoy 2: 35 events sharing one error code, spread across 4 banks — proves
  // key granularity is per (bank, errorCode), not per errorCode alone.
  const decoy2Banks = ['ICICI', 'SBI', 'KOTAK', 'YES']
  const decoy2Events = Array.from({ length: 35 }, (_, i) => ({
    idSuffix: `${runId}_decoy2_${i}`,
    bank: decoy2Banks[i % decoy2Banks.length] ?? 'ICICI',
    errorCode: 'SERVER_ERROR',
  }))

  console.log(`Firing the main burst: ${mainEvents.length} events, ${mainBank}/${mainErrorCode}...`)
  const mainIds = await fireCluster(args.baseUrl, secret, 'main', mainEvents)

  console.log(`Firing decoy 1: ${decoy1Events.length} sub-threshold events, AXIS/BAD_REQUEST_ERROR...`)
  const decoy1Ids = await fireCluster(args.baseUrl, secret, 'decoy1', decoy1Events)

  console.log(`Firing decoy 2: ${decoy2Events.length} events, one error code across 4 banks...`)
  const decoy2Ids = await fireCluster(args.baseUrl, secret, 'decoy2', decoy2Events)

  const allIds = [...mainIds, ...decoy1Ids, ...decoy2Ids]
  console.log(`Waiting for the worker to drain ${allIds.length} events...`)
  const drained = await waitForDrain(args.baseUrl, allIds)
  console.log(`worker drained: ${drained}/${allIds.length} audit rows written`)

  const [mainRows, decoy1Rows, decoy2Rows] = await Promise.all([
    fetchAuditActions(args.baseUrl, mainIds),
    fetchAuditActions(args.baseUrl, decoy1Ids),
    fetchAuditActions(args.baseUrl, decoy2Ids),
  ])

  const detectionRows: DetectionRow[] = [
    summarizeCluster('main burst (35, 1 bank/code)', mainRows, true),
    summarizeCluster('decoy 1 (12, sub-threshold)', decoy1Rows, false),
    summarizeCluster('decoy 2 (35, 4 banks)', decoy2Rows, false),
  ]

  console.log('\nDetection table:\n')
  const header = `${'Cluster'.padEnd(28)}${'Events'.padEnd(9)}${'Tripped'.padEnd(10)}${'Latency (ms)'.padEnd(15)}${'True trips'.padEnd(12)}False trips`
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of detectionRows) {
    console.log(
      `${row.cluster.padEnd(28)}${String(row.events).padEnd(9)}${String(row.tripped).padEnd(10)}${(row.detectionLatencyMs ?? '—').toString().padEnd(15)}${String(row.trueTrips).padEnd(12)}${row.falseTrips}`,
    )
  }

  const mainTripIndex = mainRows.findIndex((r) => r.retryNow.reason === 'shock_suppressed')
  if (mainTripIndex !== -1) {
    console.log(
      `\nRETRY_NOW's own EV entry flips at event ${mainTripIndex + 1}/${mainRows.length} of the main burst:`,
    )
    const before = mainRows[Math.max(0, mainTripIndex - 1)]
    const after = mainRows[mainTripIndex]
    console.log(`  before: allowed=${String(before?.retryNow.allowed)}, reason=${before?.retryNow.reason ?? 'null'}`)
    console.log(`  after:  allowed=${String(after?.retryNow.allowed)}, reason=${after?.retryNow.reason ?? 'null'}`)
    console.log(`  rationale at trip: "${after?.rationale ?? ''}"`)
  } else {
    console.log('\nWARNING: the main burst never tripped the shock detector.')
    process.exitCode = 1
  }

  const anyDecoyTripped = detectionRows.slice(1).some((r) => r.tripped)
  if (anyDecoyTripped) {
    console.log('\nWARNING: a decoy cluster tripped the shock detector — this should never happen.')
    process.exitCode = 1
  }

  if (drained !== allIds.length) {
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`burst failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
