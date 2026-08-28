/**
 * `npm run probe:razorpay` — asks the configured Razorpay TEST account which product
 * surfaces it actually has, instead of reading the docs and hoping.
 *
 * This exists because docs/adr/0010 was written exactly this way: a strict review asked
 * whether `RETRY_NOW` having no live gateway call had ever been investigated, and the
 * answer came from hitting `POST /v1/payments/create/upi` for real and getting a `400`
 * back, because S2S/Seamless is not enabled on a standard test account. Making
 * `RETRY_NOW` real needs a tokenized mandate, and whether that is reachable depends on
 * facts about this specific account rather than on what is theoretically possible.
 *
 * STRICTLY READ-ONLY. Every request below is a GET against a list endpoint. Nothing is
 * created, charged, or deleted, and test mode cannot move real money regardless —
 * src/config/env.ts refuses to boot on a `rzp_live_` key at all.
 *
 * A `200` means the surface is available. A `400`/`401` with a BAD_REQUEST_ERROR
 * usually means the feature is not enabled for this account; the raw error is printed
 * rather than interpreted, because the distinction between "not enabled", "not
 * approved", and "wrong plan" is exactly the thing worth reading verbatim.
 */
import { loadEnv } from '../src/config/env'

interface Probe {
  readonly label: string
  readonly path: string
  /** What a 200 here would let this project do. */
  readonly unlocks: string
}

const PROBES: readonly Probe[] = [
  {
    label: 'Payment Links',
    path: '/payment_links?count=1',
    unlocks: 'the PAYMENT_LINK action (already live — this is the control, it should pass)',
  },
  {
    label: 'Plans',
    path: '/plans?count=1',
    unlocks: 'Subscriptions: a plan is the first object a recurring mandate hangs off',
  },
  {
    label: 'Subscriptions',
    path: '/subscriptions?count=1',
    unlocks: 'a real recurring mandate, and the subscription.* webhooks the pipeline now handles',
  },
  {
    label: 'Customers',
    path: '/customers?count=1',
    unlocks: 'a customer to attach a mandate token to',
  },
  {
    label: 'Settlements',
    path: '/settlements?count=1',
    unlocks: 'nothing this project needs — included as a second control for account health',
  },
]

async function main(): Promise<void> {
  const env = loadEnv()
  const keyId = env.RAZORPAY_KEY_ID
  const keySecret = env.RAZORPAY_KEY_SECRET

  if (keyId === undefined || keySecret === undefined) {
    console.error(
      'No Razorpay credentials configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env\n' +
        '(test mode only — a rzp_live_ key is refused at boot).',
    )
    process.exit(1)
  }

  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
  console.log(`Probing Razorpay test account ${keyId.slice(0, 12)}… (read-only)\n`)

  const results: { label: string; status: number; ok: boolean; detail: string }[] = []

  for (const probe of PROBES) {
    let status = 0
    let detail = ''
    try {
      const res = await fetch(`https://api.razorpay.com/v1${probe.path}`, {
        headers: { Authorization: auth },
      })
      status = res.status
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const err =
          body !== null && typeof body === 'object' && 'error' in body
            ? (body as { error: { description?: string; reason?: string } }).error
            : null
        detail = err?.description ?? `HTTP ${status}`
      } else {
        const count =
          body !== null && typeof body === 'object' && 'count' in body
            ? (body as { count: number }).count
            : 0
        detail = `${count} existing record(s)`
      }
    } catch (e: unknown) {
      detail = `network error: ${e instanceof Error ? e.message : String(e)}`
    }
    const ok = status === 200
    results.push({ label: probe.label, status, ok, detail })
    console.log(`${ok ? 'AVAILABLE  ' : 'UNAVAILABLE'}  ${probe.label.padEnd(15)} ${status}  ${detail}`)
    console.log(`               ${probe.unlocks}\n`)
  }

  const subs = results.find((r) => r.label === 'Subscriptions')
  const plans = results.find((r) => r.label === 'Plans')
  console.log('---')
  if (subs?.ok === true && plans?.ok === true) {
    console.log(
      'Subscriptions IS available on this account. A real tokenized mandate is reachable,\n' +
        'which is the precondition docs/adr/0010 names for making RETRY_NOW a real call.',
    )
  } else {
    console.log(
      'Subscriptions is NOT available on this account. docs/adr/0010 stands as written:\n' +
        'there is no safe live gateway call for RETRY_NOW without a mandate, and a mandate\n' +
        'cannot be registered here. That is a finding, not a failure — record it and move on.',
    )
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`probe failed: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
