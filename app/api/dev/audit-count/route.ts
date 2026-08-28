/**
 * A dev/demo-only convenience endpoint for `scripts/replay.ts`: "how many of these
 * event ids have a recovery_audit row yet, and what did the worker measure its own
 * decision to cost for each one." Exists so the replay script never opens
 * its own database connection — PGlite is a single-process embedded database, and
 * a second process opening the same data directory while `next dev` already has it
 * open is exactly the kind of thing that corrupts an embedded store rather than
 * queuing politely the way a real Postgres server would. The running server's own
 * connection answers this instead.
 *
 * Off entirely when RECLAIM_PUBLIC_INSTANCE is set, and the id list is capped either
 * way — see src/app/dev-route-guard.ts for why both.
 */
import { getDeps } from '@/server/di'
import { guardDevRoute } from '@/app/dev-route-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps()
  const guard = guardDevRoute(req, deps.env, { count: 0, decisionLatencyMs: [] })
  if (!guard.ok) return guard.response
  const { eventIds } = guard

  // `decision_latency_ms` is the worker's own measurement of job-pickup -> action
  // chosen (src/app/worker/process-event.ts's t0). Returned alongside the count so
  // `npm run replay` can report a real decision latency instead of relabelling the
  // route's ack latency as one, which is what it used to do.
  const { rows } = await deps.sql.query<{ event_id: string; decision_latency_ms: number | null }>(
    `SELECT event_id, decision_latency_ms
       FROM recovery_audit
      WHERE event_id = ANY($1)`,
    [[...eventIds]],
  )
  return Response.json(
    {
      count: rows.length,
      decisionLatencyMs: rows
        .map((r) => r.decision_latency_ms)
        .filter((ms): ms is number => ms !== null),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
