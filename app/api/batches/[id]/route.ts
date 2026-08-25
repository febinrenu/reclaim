/**
 * `GET /api/batches/:id` — the polling-fallback transport (BUILD_PLAN.md C5:
 * SSE is for localhost only, never the tunnel). Shares `getBatchReport` and
 * `serializeBatchReport` with the SSE route, so the two transports can never
 * disagree about a number.
 */
import { getDeps } from '@/server/di'
import { getBatchReport } from '@/app/batch/run-batch'
import { serializeBatchReport } from '@/app/batch/serialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const deps = await getDeps()
  const report = await getBatchReport(deps, id)
  if (report.batch === null) {
    return new Response('batch not found', { status: 404 })
  }
  return Response.json(serializeBatchReport(report))
}
