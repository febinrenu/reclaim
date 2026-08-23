/**
 * HMAC verification for the Razorpay webhook envelope (SYSTEM_SPEC.md §9,
 * BUILD_PLAN.md §5.5 step 3). `node:crypto` is the one exception ESLint boundary
 * rule 1 carves out of src/domain's "no I/O" ban — for hashing only — and this is
 * exactly that: no network, no filesystem, a pure function of its three arguments.
 *
 * Two real bugs in the spec's own snippet, both fixed here:
 *
 *   1. `crypto.timingSafeEqual` throws on a length mismatch instead of returning
 *      false, so a signature header of the wrong length would crash the request
 *      handler rather than being rejected cleanly. The spec's guard
 *      (`expected.length === signature.length && timingSafeEqual(...)`) avoids the
 *      throw, but the short-circuit itself leaks a length-dependent timing
 *      difference before `timingSafeEqual` is ever reached. Fixed by hashing BOTH
 *      sides to a fixed length *first*, so there is no length branch on
 *      attacker-controlled input at all — a wrong-length or malformed header
 *      simply hashes to something that will not match, in constant time.
 *   2. `Buffer.from(signature, "hex")` on a non-hex string (say, `"zz..."`)
 *      silently decodes to a truncated or empty buffer rather than throwing —
 *      exactly the kind of node quirk that turns "reject bad input" into "compare
 *      against something that was never the real signature, unpredictably."
 *      Never hex-decoding the header at all removes this failure mode entirely:
 *      it is hashed as the raw string it is.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

function fixedLengthDigest(value: string): Buffer {
  return createHmac('sha256', 'reclaim-signature-compare').update(value).digest()
}

export function computeWebhookSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (signatureHeader === null || signatureHeader === undefined || signatureHeader === '') {
    return false
  }
  const expected = computeWebhookSignature(rawBody, secret)
  return timingSafeEqual(fixedLengthDigest(expected), fixedLengthDigest(signatureHeader))
}
