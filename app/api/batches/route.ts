/**
 * `POST /api/batches` — starts a D9 batch run. Returns as soon as the `batches`
 * row exists (fast, one INSERT) so the client has a real `batchId` to stream
 * or poll against immediately; the actual ingest-and-drain work continues via
 * `after()`, the same non-blocking-kick pattern the webhook route already uses.
 *
 * `GET /api/batches` — D12's simulator page: recent completed live batches to
 * pick a baseline from.
 */
import { after } from 'next/server'
import { getDeps } from '@/server/di'
import { startBatchRun, driveBatchToCompletion, clampBatchTotal } from '@/app/batch/run-batch'
import * as batchesRepo from '@/repositories/batches.repo'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_TOTAL = 60
// A batch is real work — the full decision pipeline, real database writes, real
// Groq calls once the language cache misses. 5 per 5 minutes per IP is generous
// for a genuine reviewer clicking "Run batch" repeatedly, and a real ceiling on
// unauthenticated repeated abuse.
const BATCH_RATE_LIMIT = 5
const BATCH_RATE_WINDOW_SECONDS = 300

export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps()

  const rateLimit = await checkRateLimit(deps.kv, 'batches', clientKeyFrom(req), BATCH_RATE_LIMIT, BATCH_RATE_WINDOW_SECONDS)
  if (!rateLimit.allowed) {
    return new Response('rate limit exceeded, try again shortly', {
      status: 429,
      headers: { 'retry-after': String(rateLimit.retryAfterSeconds) },
    })
  }

  let total = DEFAULT_TOTAL
  try {
    const body = (await req.json()) as { total?: unknown }
    if (typeof body.total === 'number') total = clampBatchTotal(body.total)
  } catch {
    // No body, or not JSON — the default total is fine.
  }

  const batch = await startBatchRun(deps, { total })

  after(() => {
    driveBatchToCompletion(deps, batch).catch((err: unknown) => {
      deps.logger.error(
        { event: 'batch_run_failed', batchId: batch.id, error: err instanceof Error ? err.message : String(err) },
        'batch run failed',
      )
    })
  })

  return Response.json({ batchId: batch.id, total: batch.total }, { status: 202 })
}

export async function GET(): Promise<Response> {
  const deps = await getDeps()
  const batches = await batchesRepo.listRecentLive(deps.sql)
  return Response.json({
    batches: batches.map((b) => ({
      id: b.id,
      total: b.total,
      done: b.done,
      failed: b.failed,
      startedAt: b.startedAt.toISOString(),
      finishedAt: b.finishedAt === null ? null : b.finishedAt.toISOString(),
    })),
  })
}
