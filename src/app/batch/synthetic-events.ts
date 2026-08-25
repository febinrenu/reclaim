/**
 * Synthetic `payment.failed` envelopes for the D9 batch runner — the same shape
 * `scripts/replay.ts` posts over HTTP, generated in-process instead since the
 * batch runner already runs server-side inside the app it is driving. Not
 * seeded for byte-for-byte reproducibility (unlike `scripts/data/`'s D4
 * generator): a dashboard demo batch is meant to look different each run, and
 * every synthetic event carries a fresh `pay_batch_<batchId>_<i>` id, so two
 * batches never collide on identity even if run back to back.
 *
 * **Every event also gets its own fresh, batch-scoped `customer_id`
 * (`cust_batch_<batchId>_<i>`), not a small shared pool.** This used to reuse
 * a 15-customer pool across every batch ever run — harmless while
 * `cardVelocityHigh`/`cardFirstSeenRecently` were hardcoded `false`, but the
 * moment D11's real-risk-signal fix landed (`src/app/worker/live-risk-signals.ts`),
 * that shared pool meant every batch beyond the first few events had
 * accumulated enough same-customer failures across every prior run this
 * session to trip the velocity signal on event zero — a real, caught-live
 * regression: `npm run` a 300-event batch and every single decision came back
 * `ESCALATE_HUMAN`, see `docs/INCIDENTS.md`. The batch runner's job is to
 * show a representative decision *distribution*; deliberately correlated
 * failures are what `npm run burst` exists to demonstrate on purpose.
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
            customer_id: `cust_batch_${batchId}_${i}`,
          },
        },
      },
      created_at: nowSec,
    }
    return { eventId, rawBody: JSON.stringify(envelope) }
  })
}
