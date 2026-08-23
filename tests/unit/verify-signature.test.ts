import { describe, it, expect } from 'vitest'
import { verifyWebhookSignature, computeWebhookSignature } from '@/domain/webhooks/verify-signature'

/**
 * Independently computed in Python (`hmac.new(secret, body, hashlib.sha256).hexdigest()`),
 * not derived from this codebase's own HMAC call — BUILD_PLAN.md §6.10: "independent
 * derivation is what makes it a vector rather than a tautology."
 */
const SECRET = 'whsec_test_known_vector'
const BODY =
  '{"entity":"event","event":"payment.failed","created_at":1735689600,"payload":{"payment":{"entity":{"id":"pay_test123"}}}}'
const KNOWN_GOOD_SIGNATURE = 'd83fc74906cd89cbc975e4859bafd71b557436abbbbf1920320379465fad07ad'

describe('verifyWebhookSignature', () => {
  it('accepts a signature computed independently in Python', () => {
    expect(verifyWebhookSignature(BODY, KNOWN_GOOD_SIGNATURE, SECRET)).toBe(true)
  })

  it('matches computeWebhookSignature exactly', () => {
    expect(computeWebhookSignature(BODY, SECRET)).toBe(KNOWN_GOOD_SIGNATURE)
  })

  it('rejects a signature computed over the JSON-reparsed body', () => {
    // JSON.stringify(JSON.parse(raw)) !== raw in general — reordered keys, extra
    // whitespace, a non-ASCII character. Verification must happen over the exact
    // raw bytes, never a reparsed-and-restringified version. This fixture
    // deliberately has reordered keys and irregular spacing so the round trip
    // actually changes the bytes, rather than happening to survive it.
    const quirky =
      '{"event":  "payment.failed", "entity":"event","created_at":1735689600,"payload":{"payment":{"entity":{"id":"pay_test123"}}}}'
    const reparsed = JSON.stringify(JSON.parse(quirky))
    expect(reparsed).not.toBe(quirky) // the fixture must actually exercise the gap
    const signatureOverQuirky = computeWebhookSignature(quirky, SECRET)
    expect(verifyWebhookSignature(reparsed, signatureOverQuirky, SECRET)).toBe(false)
  })

  it('rejects a one-nibble difference', () => {
    const flipped = KNOWN_GOOD_SIGNATURE.slice(0, -1) + (KNOWN_GOOD_SIGNATURE.at(-1) === '0' ? '1' : '0')
    expect(verifyWebhookSignature(BODY, flipped, SECRET)).toBe(false)
  })

  it('rejects a valid-hex signature of the wrong length, without throwing', () => {
    expect(() => verifyWebhookSignature(BODY, KNOWN_GOOD_SIGNATURE.slice(0, 10), SECRET)).not.toThrow()
    expect(verifyWebhookSignature(BODY, KNOWN_GOOD_SIGNATURE.slice(0, 10), SECRET)).toBe(false)
  })

  it('rejects non-hex input rather than silently decoding to an empty buffer', () => {
    // Buffer.from("zz", "hex") silently yields an empty buffer — the exact node
    // quirk this module's design (never hex-decoding the header) avoids entirely.
    expect(verifyWebhookSignature(BODY, 'zz'.repeat(32), SECRET)).toBe(false)
  })

  it('rejects an absent signature header', () => {
    expect(verifyWebhookSignature(BODY, null, SECRET)).toBe(false)
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toBe(false)
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false)
  })

  it('rejects the right signature under the wrong secret', () => {
    expect(verifyWebhookSignature(BODY, KNOWN_GOOD_SIGNATURE, 'wrong_secret')).toBe(false)
  })
})
