/**
 * `GET /api/batches/:id/stream` — Server-Sent Events, localhost only
 * (BUILD_PLAN.md C5: Cloudflare Quick Tunnel does not support SSE and caps at
 * 200 concurrent requests — never put the tunnel on this path; the dashboard's
 * client falls back to polling `/api/batches/:id` automatically when SSE
 * fails). Polls the same `getBatchReport` the plain-JSON route calls, every
 * 400ms, and closes itself once the batch leaves `running`.
 */
import { getDeps } from '@/server/di'
import { getBatchReport } from '@/app/batch/run-batch'
import { serializeBatchReport } from '@/app/batch/serialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POLL_INTERVAL_MS = 400

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const deps = await getDeps()
  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true
        }
      }

      while (!closed) {
        const report = await getBatchReport(deps, id)
        if (report.batch === null) {
          send('error', { message: 'batch not found' })
          break
        }
        send('progress', serializeBatchReport(report))
        if (report.batch.status !== 'running') {
          send('done', serializeBatchReport(report))
          break
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }

      if (!closed) {
        closed = true
        controller.close()
      }
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
