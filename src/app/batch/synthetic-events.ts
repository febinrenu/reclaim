/**
 * Synthetic `payment.failed` envelopes for the D9 batch runner — the same shape
 * `scripts/replay.ts` posts over HTTP, generated in-process instead since the
 * batch runner already runs server-side inside the app it is driving. Not
 * seeded for byte-for-byte reproducibility (unlike `scripts/data/`'s D4
 * generator): a dashboard demo batch is meant to look different each run, and
 * every synthetic event carries a fresh `pay_batch_<batchId>_<i>` id, so two
 * batches never collide on identity even if run back to back.
 */
export interface SyntheticEvent {
  readonly eventId: string
  readonly rawBody: string
}

const ERROR_CODES = ['BAD_REQUEST_ERROR', 'GATEWAY_ERROR', 'SERVER_ERROR'] as const

export function makeSyntheticEvents(batchId: string, n: number, nowMs: number): readonly SyntheticEvent[] {
  const nowSec = Math.floor(nowMs / 1000)
  return Array.from({ length: n }, (_, i) => {
    const paymentId = `pay_batch_${batchId}_${i}`
    const eventId = `evt_batch_${batchId}_${i}`
    const envelope = {
      entity: 'event',
      event: 'payment.failed',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 100_00 + (i % 37) * 7_00,
            currency: 'INR',
            status: 'failed',
            error_code: ERROR_CODES[i % ERROR_CODES.length],
            error_description: 'synthetic batch-runner event',
            customer_id: `cust_batch_${i % 15}`,
          },
        },
      },
      created_at: nowSec,
    }
    return { eventId, rawBody: JSON.stringify(envelope) }
  })
}
