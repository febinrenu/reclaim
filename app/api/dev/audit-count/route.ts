/**
 * A dev/demo-only convenience endpoint for `scripts/replay.ts`: "how many of these
 * event ids have a recovery_audit row yet." Exists so the replay script never opens
 * its own database connection — PGlite is a single-process embedded database, and
 * a second process opening the same data directory while `next dev` already has it
 * open is exactly the kind of thing that corrupts an embedded store rather than
 * queuing politely the way a real Postgres server would. The running server's own
 * connection answers this instead.
 */
import { getDeps } from '@/server/di'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const idsParam = url.searchParams.get('eventIds') ?? ''
  const eventIds = idsParam.split(',').filter((s) => s.length > 0)
  if (eventIds.length === 0) {
    return Response.json({ count: 0 }, { headers: { 'cache-control': 'no-store' } })
  }

  const deps = await getDeps()
  const { rows } = await deps.sql.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = ANY($1)`,
    [eventIds],
  )
  const count = Number(rows[0]?.count ?? 0)
  return Response.json({ count }, { headers: { 'cache-control': 'no-store' } })
}
