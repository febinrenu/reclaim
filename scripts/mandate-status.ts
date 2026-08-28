/**
 * `npm run mandate:status -- --id sub_xxx` — reads back what actually happened after the
 * human authorisation step, and reports whether a real token now exists.
 *
 * Read-only. This is the checkpoint between "a subscription was created" and "a
 * server-initiated charge is possible": the token is the whole question, because
 * docs/adr/0010's conclusion turns entirely on whether one exists to charge against.
 *
 * It deliberately does not attempt a charge. Whether the explicit charge-against-token
 * API is reachable on this account is a separate question with its own probe, and
 * conflating "did the mandate register" with "can we charge it" would make a failure
 * ambiguous between two very different causes.
 */
import { loadEnv } from '../src/config/env'

const API = 'https://api.razorpay.com/v1'

function parseArgs(argv: readonly string[]): { readonly id: string | null } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id' && argv[i + 1] !== undefined) return { id: String(argv[i + 1]) }
  }
  return { id: null }
}

async function get(path: string, auth: string): Promise<Record<string, unknown> | { __error: string }> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: auth } })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const err = json.error as { description?: string } | undefined
    return { __error: `HTTP ${res.status}: ${err?.description ?? JSON.stringify(json)}` }
  }
  return json
}

async function main(): Promise<void> {
  const { id } = parseArgs(process.argv.slice(2))
  if (id === null) {
    console.error('usage: npm run mandate:status -- --id sub_xxxxxxxxxxxx')
    process.exit(1)
  }

  const env = loadEnv()
  const keyId = env.RAZORPAY_KEY_ID
  const keySecret = env.RAZORPAY_KEY_SECRET
  if (keyId === undefined || keySecret === undefined) {
    console.error('No Razorpay credentials in .env.')
    process.exit(1)
  }
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`

  const sub = await get(`/subscriptions/${id}`, auth)
  if ('__error' in sub) {
    console.error(`could not read ${id}: ${sub.__error}`)
    process.exit(1)
  }

  const status = String(sub.status)
  console.log(`subscription  ${id}`)
  console.log(`status        ${status}`)
  console.log(`paid_count    ${String(sub.paid_count ?? 0)}   remaining ${String(sub.remaining_count ?? '?')}`)
  console.log(`customer      ${String(sub.customer_id ?? '(none recorded)')}`)

  // The token is the entire point of this exercise.
  const customerId = typeof sub.customer_id === 'string' ? sub.customer_id : null
  let tokenId: string | null = null
  if (customerId !== null) {
    const tokens = await get(`/customers/${customerId}/tokens`, auth)
    if ('__error' in tokens) {
      console.log(`tokens        could not read (${tokens.__error})`)
    } else {
      const items = (tokens.items as { id?: string; method?: string; recurring?: boolean }[]) ?? []
      console.log(`tokens        ${items.length} on file`)
      for (const t of items) {
        console.log(`              ${t.id ?? '?'}  method=${t.method ?? '?'}  recurring=${String(t.recurring ?? false)}`)
        if (tokenId === null && t.id !== undefined) tokenId = t.id
      }
    }
  }

  console.log('\n---')
  if (status === 'active' || status === 'authenticated') {
    console.log('The mandate registered. A real token exists to charge against, which is the')
    console.log('precondition docs/adr/0010 names.')
    if (tokenId !== null) console.log(`\nNext: npm run mandate:probe-charge -- --id ${id} --token ${tokenId}`)
    else console.log('\nNext: npm run mandate:probe-charge -- --id ' + id)
  } else if (status === 'created') {
    console.log('Still awaiting authorisation — the short_url has not been completed yet.')
    console.log('Open it and pay with the test VPA success@razorpay, then re-run this.')
  } else {
    console.log(`Status is "${status}". If this is "halted" or "cancelled" the mandate did not`)
    console.log('register; create a fresh subscription with npm run mandate:setup and retry.')
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`mandate:status failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
