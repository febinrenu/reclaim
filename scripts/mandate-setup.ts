/**
 * `npm run mandate:setup` — creates the Razorpay TEST-mode objects a real recurring
 * mandate needs, and prints the authorisation URL a human has to open.
 *
 * This is step one of superseding docs/adr/0010. That ADR concluded RETRY_NOW has no safe
 * live gateway call, because no card network or UPI rail lets a merchant backend
 * re-charge a customer without either a registered mandate or a fresh customer-facing
 * authorisation — and this project's one-time `payment.failed` path has no token. The ADR
 * names its own escape hatch: get a real tokenized mandate, and RETRY_NOW can call a real
 * API. `npm run probe:razorpay` confirmed Subscriptions is available on this account, so
 * the mandate is reachable.
 *
 * WRITES to the Razorpay test account: one plan, one customer, one subscription. All
 * cancellable, all test mode, and src/config/env.ts refuses to boot on a `rzp_live_` key
 * at all, so no real money can be involved by construction.
 *
 * Two deliberate choices worth stating:
 *
 *   * `customer_notify: 0`. This repository's constitutional constraints include "no
 *     unsolicited messages to real phone numbers or email addresses" (README, Constraints
 *     held throughout). Razorpay would otherwise email and SMS the customer about the
 *     mandate. Nothing here contacts anyone, and no real contact detail is needed either:
 *     the mandate is authorised by opening a URL, not by receiving a message.
 *   * **No customer is pre-created, and no `customer_id` is passed.** The first version of
 *     this script created one and attached it, which seemed tidier and silently broke the
 *     hosted authorisation page — it rendered "Hosted page is not available. Please
 *     contact the merchant." Isolated by building three subscriptions differing in one
 *     variable each: without a `customer_id` the page loads, with one it fails, and it
 *     fails identically whether the customer's email is a reserved `.invalid` domain or an
 *     ordinary one. So the cause is pre-binding a customer, not the address. The hosted
 *     page collects the payer itself, which is the whole reason it exists.
 *
 * The authorisation step itself is deliberately human and cannot be scripted. That is the
 * whole point: it is the consent capture that makes a later server-initiated charge
 * legitimate, and its absence is exactly why ADR 0010 concluded what it did.
 */
import { loadEnv } from '../src/config/env'

const API = 'https://api.razorpay.com/v1'

/** ₹499/month, 12 cycles — an ordinary subscription shape rather than a contrived one. */
const PLAN = {
  period: 'monthly',
  interval: 1,
  item: {
    name: 'Reclaim recurring-mandate test plan',
    amount: 49900,
    currency: 'INR',
    description: 'Test-mode plan used only to register a mandate for docs/adr/0010',
  },
}

async function call(path: string, auth: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const err = json.error as { description?: string; reason?: string } | undefined
    throw new Error(
      `${path} -> HTTP ${res.status}: ${err?.description ?? JSON.stringify(json)}` +
        (err?.reason !== undefined ? ` (reason: ${err.reason})` : ''),
    )
  }
  return json
}

async function main(): Promise<void> {
  const env = loadEnv()
  const keyId = env.RAZORPAY_KEY_ID
  const keySecret = env.RAZORPAY_KEY_SECRET
  if (keyId === undefined || keySecret === undefined) {
    console.error('No Razorpay credentials in .env — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.')
    process.exit(1)
  }
  if (!keyId.startsWith('rzp_test_')) {
    console.error(`Refusing to run: ${keyId.slice(0, 10)}… is not a test key.`)
    process.exit(1)
  }
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`

  console.log('Creating test-mode objects (plan, customer, subscription)…\n')

  const plan = await call('/plans', auth, PLAN)
  console.log(`plan          ${String(plan.id)}   ₹${PLAN.item.amount / 100}/month`)

  console.log('customer      (none — the hosted page collects the payer; see the docstring)')

  const subscription = await call('/subscriptions', auth, {
    plan_id: plan.id,
    total_count: 12,
    // See the module docstring: this repository does not send unsolicited messages.
    customer_notify: 0,
    // Deliberately NO customer_id. Passing one breaks the hosted authorisation page —
    // established by isolation, not inferred from the error text.
    notes: { purpose: 'docs/adr/0010 — register a real mandate so RETRY_NOW can be real' },
  })

  const shortUrl = subscription.short_url
  console.log(`subscription  ${String(subscription.id)}   status=${String(subscription.status)}`)
  console.log('\n' + '='.repeat(78))
  console.log('AUTHORISE THE MANDATE — this step is human and cannot be scripted.\n')
  console.log(`  1. Open:  ${String(shortUrl)}`)
  console.log('  2. Choose UPI and pay with the test VPA:  success@razorpay')
  console.log('     (test mode mocks the mandate — no real OTP, no real money, no real payer)')
  console.log('  3. Come back and run:  npm run mandate:status -- --id ' + String(subscription.id))
  console.log('='.repeat(78))
  console.log(
    '\nNothing was sent to anyone: customer_notify=0 and no customer record exists yet.' +
      '\nThe mandate is authorised by opening that URL, not by receiving a message.',
  )

  // A subscription whose hosted page renders an error is indistinguishable from a working
  // one at the API level — `status: "created"` and a valid `short_url` either way. That is
  // exactly how the first attempt wasted a person's time: the script reported success and
  // the page said "Hosted page is not available." Checked here so the failure is caught by
  // the thing that created it rather than by whoever clicks the link.
  try {
    const page = await fetch(String(shortUrl), { redirect: 'follow' })
    const html = await page.text()
    if (/not available|contact the merchant/i.test(html)) {
      console.log(
        '\nWARNING: that hosted page renders an error rather than a checkout. It is' +
          '\nreachable but unusable, so authorisation cannot succeed. Do not open it.',
      )
      process.exitCode = 1
    } else {
      console.log('\nHosted page checked: it renders a real checkout, not an error.')
    }
  } catch {
    console.log('\n(could not pre-check the hosted page — open it and see)')
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\nmandate:setup failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
