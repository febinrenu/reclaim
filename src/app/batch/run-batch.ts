/**
 * The D9 batch runner: creates a `batches` row, posts N synthetic
 * `payment.failed` events through the exact same signed-webhook path a real
 * Razorpay delivery uses (`ingestRazorpayEvent`, tagged with this run's
 * `batchId`), then actively drains the queue until this batch's own
 * `done + failed` reaches its `total` — not until the queue is globally empty,
 * since the embedded poller may also be draining concurrently (harmless:
 * `claimNext` is `FOR UPDATE SKIP LOCKED`).
 *
 * `source: 'batch_replay'` (src/ports/executor.ts) makes every one of these
 * dry_run structurally, regardless of credentials — see BUILD_PLAN.md's D8
 * exit test. `getBatchReport` is the one function the plain-JSON status route
 * and the SSE stream both call, so the two transports can never disagree
 * (BUILD_PLAN.md's D9 exit test: "force polling and the numbers are identical").
 */
import type { Deps } from '@/config/container'
import { computeWebhookSignature } from '@/domain/webhooks/verify-signature'
import { ingestRazorpayEvent } from '@/app/webhook/ingest-razorpay-event'
import { drainOnce } from '@/app/worker/drain'
import * as batchesRepo from '@/repositories/batches.repo'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import { makeSyntheticEvents } from './synthetic-events'
import { buildBatchReport, type BatchReport } from './batch-metrics'

export interface RunBatchOptions {
  readonly total: number
}

export const MAX_BATCH_TOTAL = 300 // SYSTEM_SPEC.md §9: "~200-300 synthetic ... records"
const DRAIN_DEADLINE_MS = 120_000

export function clampBatchTotal(n: number): number {
  return Math.max(1, Math.min(Math.trunc(n) || 1, MAX_BATCH_TOTAL))
}

/** Creates the `batches` row only — fast, synchronous, so a route handler can
 * return a real `batchId` to the client immediately and start the actual
 * ingest-and-drain work afterwards (via `after()`), without the client's
 * first request hanging open for however long the whole batch takes. */
export async function startBatchRun(deps: Deps, opts: RunBatchOptions): Promise<batchesRepo.BatchRow> {
  const total = clampBatchTotal(opts.total)
  return batchesRepo.startBatch(deps.sql, { scenario: 'subscription', kind: 'live', total })
}

/** The actual work: post every synthetic event, then drain until this batch's
 * own counters say it is done. Call after `startBatchRun` has already
 * returned the row to the caller. */
export async function driveBatchToCompletion(deps: Deps, batch: batchesRepo.BatchRow): Promise<void> {
  const events = makeSyntheticEvents(batch.id, batch.total, deps.clock.nowMs())
  for (const event of events) {
    const signature = computeWebhookSignature(event.rawBody, deps.webhookSecret)
    const result = await ingestRazorpayEvent(deps, {
      rawBody: event.rawBody,
      signatureHeader: signature,
      eventIdHeader: event.eventId,
      batchId: batch.id,
    })
    if (result.kind !== 'accepted' && result.kind !== 'duplicate') {
      deps.logger.error(
        { event: 'batch_ingest_failed', batchId: batch.id, kind: result.kind },
        'a synthetic batch event was rejected at ingest',
      )
    }
  }

  const deadline = Date.now() + DRAIN_DEADLINE_MS
  while (Date.now() < deadline) {
    const row = await batchesRepo.findBatchById(deps.sql, batch.id)
    if (row === null || row.done + row.failed >= row.total) break
    const result = await drainOnce(deps, { maxJobs: 5, budgetMs: 2000, workerId: `batch:${batch.id}` })
    if (result.claimed === 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  await batchesRepo.finishBatch(deps.sql, batch.id, 'done')
}

export interface BatchReportWithRow extends BatchReport {
  readonly batch: batchesRepo.BatchRow | null
}

export async function getBatchReport(deps: Deps, batchId: string): Promise<BatchReportWithRow> {
  const [batch, rows] = await Promise.all([
    batchesRepo.findBatchById(deps.sql, batchId),
    recoveryAuditRepo.listByBatch(deps.sql, batchId),
  ])
  return { batch, ...buildBatchReport(rows) }
}
