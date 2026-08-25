/**
 * `drainOnce` (BUILD_PLAN.md §5.7): the one code path every trigger — the embedded
 * poller, the standalone worker, a future `after()` self-kick, a manual button —
 * calls identically. Claims up to `maxJobs`, or until `budgetMs` elapses, whichever
 * comes first, and reports what happened so a serverless trigger can immediately
 * re-kick while `remaining > 0`.
 *
 * T2 CLAIM is here, not in `processEvent`: claiming is a single atomic statement
 * (`FOR UPDATE SKIP LOCKED`, with expired-lease reclaim folded into the same
 * query — see job-queue.repo.ts's `claimNext`), and keeping it at this level is
 * what makes `RECLAIM_CRASH_AFTER=claim` a clean, one-line crash point.
 */
import type { Deps } from '@/config/container'
import * as jobQueueRepo from '@/repositories/job-queue.repo'
import * as batchesRepo from '@/repositories/batches.repo'
import { processEvent } from './process-event'

/** A batch-runner (D9) job's payload always carries the batchId it belongs to
 * (see src/app/webhook/ingest-razorpay-event.ts); a real webhook delivery's
 * never does. `claimed`/`failed` are bumped here, the one place every trigger
 * drains through, rather than by the batch runner guessing which jobs were
 * "its own" from a generic queue drain. `done` is bumped by `processEvent`
 * itself, inside the same T4 transaction as the audit row it corresponds to. */
function batchIdOf(job: jobQueueRepo.JobRow): string | null {
  const payload = job.payload as { batchId?: unknown }
  return typeof payload.batchId === 'string' ? payload.batchId : null
}

export interface DrainOptions {
  readonly maxJobs: number
  readonly budgetMs: number
  readonly workerId: string
  readonly leaseSeconds?: number
}

export interface DrainResult {
  readonly claimed: number
  readonly done: number
  readonly failed: number
  readonly remaining: number
}

export async function drainOnce(deps: Deps, opts: DrainOptions): Promise<DrainResult> {
  const startMs = deps.clock.nowMs()
  const leaseSeconds = opts.leaseSeconds ?? 30
  let claimed = 0
  let done = 0
  let failed = 0

  while (claimed < opts.maxJobs && deps.clock.nowMs() - startMs < opts.budgetMs) {
    const job = await deps.sql.transaction((tx) =>
      jobQueueRepo.claimNext(tx, { workerId: opts.workerId, leaseSeconds }),
    )
    if (job === null) break
    claimed++
    const batchId = batchIdOf(job)
    if (batchId !== null) await batchesRepo.bumpBatchCounters(deps.sql, batchId, { claimed: 1 })

    if (deps.env.RECLAIM_CRASH_AFTER === 'claim') {
      deps.logger.warn({ event: 'crash_injection', point: 'claim', jobId: job.id }, 'RECLAIM_CRASH_AFTER=claim')
      process.exit(1)
    }

    try {
      await processEvent(deps, job)
      done++
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      deps.logger.error({ event: 'job_failed', jobId: job.id, error: message }, 'process-event failed')
      await deps.sql.transaction((tx) => jobQueueRepo.fail(tx, job.id, { error: message }))
      if (batchId !== null) await batchesRepo.bumpBatchCounters(deps.sql, batchId, { failed: 1 })
    }
  }

  const remaining = await jobQueueRepo.countPending(deps.sql)
  return { claimed, done, failed, remaining }
}
