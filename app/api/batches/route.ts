/**
 * `POST /api/batches` — starts a D9 batch run. Returns as soon as the `batches`
 * row exists (fast, one INSERT) so the client has a real `batchId` to stream
 * or poll against immediately; the actual ingest-and-drain work continues via
 * `after()`, the same non-blocking-kick pattern the webhook route already uses.
 */
import { after } from 'next/server'
import { getDeps } from '@/server/di'
import { startBatchRun, driveBatchToCompletion, clampBatchTotal } from '@/app/batch/run-batch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_TOTAL = 60

export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps()

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
