import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRazorpayPayments } from '@/adapters/payments/razorpay'

/**
 * The constraint under test is constitutional, not cosmetic: "no unsolicited messages to
 * real phone numbers or email addresses" (README, Constraints held throughout). Every
 * customer in every scenario here is synthetic, so the only address this project may ever
 * message is one whose owner configured it themselves.
 *
 * These assert the request body actually sent to Razorpay, by capturing `fetch`, because
 * the failure mode being guarded against is silent: a Payment Link with `notify.email:
 * true` and a plausible-looking address in `customer` would look completely normal in
 * every log this project keeps, right up until a real person received it.
 */
function captureFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const stub = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    return {
      ok: true,
      json: async () => ({ id: 'plink_test', short_url: 'https://rzp.io/i/test' }),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', stub)
  return calls
}

const REQ = { transactionId: 'pay_test_1', amountPaise: 50_000, customerId: 'cust_synthetic_7' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createRazorpayPayments — notification safety', () => {
  it('sends no notification and no contact details by default', async () => {
    const calls = captureFetch()
    await createRazorpayPayments('rzp_test_x', 'secret').createPaymentLink(REQ)

    const body = calls[0]!.body
    expect(body.notify).toEqual({ sms: false, email: false })
    // The whole point: nothing that could reach a person leaves the process.
    expect(body.customer).toBeUndefined()
  })

  it('never sends the internal customer id as a phone number', async () => {
    // This is what the adapter used to do — `customer: { contact: req.customerId }` —
    // where customerId is an identifier like `cust_synthetic_7`, not a contact. Inert
    // while notifications were off, and a wrong destination the moment they were not.
    const calls = captureFetch()
    await createRazorpayPayments('rzp_test_x', 'secret', {
      email: 'operator@example.com',
      contact: null,
    }).createPaymentLink(REQ)

    expect(JSON.stringify(calls[0]!.body)).not.toContain('cust_synthetic_7')
  })

  it('notifies only the consented email when only an email is configured', async () => {
    const calls = captureFetch()
    await createRazorpayPayments('rzp_test_x', 'secret', {
      email: 'operator@example.com',
      contact: null,
    }).createPaymentLink(REQ)

    const body = calls[0]!.body
    expect(body.notify).toEqual({ sms: false, email: true })
    expect(body.customer).toEqual({ email: 'operator@example.com' })
  })

  it('notifies only the consented contact when only a contact is configured', async () => {
    const calls = captureFetch()
    await createRazorpayPayments('rzp_test_x', 'secret', {
      email: null,
      contact: '+919876543210',
    }).createPaymentLink(REQ)

    const body = calls[0]!.body
    expect(body.notify).toEqual({ sms: true, email: false })
    expect(body.customer).toEqual({ contact: '+919876543210' })
  })

  it('notifies both channels only when both are configured', async () => {
    const calls = captureFetch()
    await createRazorpayPayments('rzp_test_x', 'secret', {
      email: 'operator@example.com',
      contact: '+919876543210',
    }).createPaymentLink(REQ)

    expect(calls[0]!.body.notify).toEqual({ sms: true, email: true })
  })

  it('treats an all-null recipient as no recipient, not as consent', async () => {
    // A half-built config object must fail closed. `{email: null, contact: null}` is the
    // shape an env with neither variable set would produce if someone wired it carelessly.
    const calls = captureFetch()
    await createRazorpayPayments('rzp_test_x', 'secret', {
      email: null,
      contact: null,
    }).createPaymentLink(REQ)

    const body = calls[0]!.body
    expect(body.notify).toEqual({ sms: false, email: false })
    expect(body.customer).toBeUndefined()
  })
})
