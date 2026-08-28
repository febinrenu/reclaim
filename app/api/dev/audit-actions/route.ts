/**
 * A dev/demo-only convenience endpoint for `scripts/burst.ts`: "for these event
 * ids, in order, what action did the system choose, and was it shock-suppressed."
 * Same rationale as `/api/dev/audit-count`: the script never opens its own
 * database connection, since PGlite is single-process and a second connection
 * against the same data directory risks corrupting it.
 *
 * Off entirely when RECLAIM_PUBLIC_INSTANCE is set, and the id list is capped either
 * way — see src/app/dev-route-guard.ts for why both.
 */
import { getDeps } from '@/server/di'
import { guardDevRoute } from '@/app/dev-route-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface EvBreakdownEntry {
  action?: unknown
  allowed?: unknown
  disallowedReason?: unknown
}

interface Row {
  event_id: string
  chosen_action: string
  rationale: string | null
  ev_breakdown: unknown
  created_at: Date
}

function retryNowStatus(evBreakdown: unknown): { allowed: boolean | null; reason: string | null } {
  if (!Array.isArray(evBreakdown)) return { allowed: null, reason: null }
  const entry = (evBreakdown as EvBreakdownEntry[]).find((b) => b.action === 'RETRY_NOW')
  if (entry === undefined) return { allowed: null, reason: null }
  return {
    allowed: typeof entry.allowed === 'boolean' ? entry.allowed : null,
    reason: typeof entry.disallowedReason === 'string' ? entry.disallowedReason : null,
  }
}

export async function GET(req: Request): Promise<Response> {
  const deps = await getDeps()
  const guard = guardDevRoute(req, deps.env, { rows: [] })
  if (!guard.ok) return guard.response
  const { eventIds } = guard

  const { rows } = await deps.sql.query<Row>(
    `SELECT event_id, chosen_action, rationale, ev_breakdown, created_at
     FROM recovery_audit
     WHERE event_id = ANY($1)
     ORDER BY created_at`,
    [[...eventIds]],
  )
  return Response.json(
    {
      rows: rows.map((r) => ({
        eventId: r.event_id,
        chosenAction: r.chosen_action,
        rationale: r.rationale,
        createdAt: r.created_at,
        retryNow: retryNowStatus(r.ev_breakdown),
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
