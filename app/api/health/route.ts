import { getDeps } from '@/server/di'
import { VERSION } from '@/config/version'

// Configuration is read at request time, so this must never be cached or
// statically evaluated at build.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Machine-readable form of the boot banner.
 *
 * Deliberately reports which adapter backs every port, including the local ones.
 * A health endpoint that only says "ok" tells a reader nothing they could not have
 * guessed from the page loading.
 */
export async function GET() {
  const { capabilities, clock } = await getDeps()

  return Response.json(
    {
      ok: true,
      version: VERSION,
      mode: capabilities.fullyLocal
        ? 'local'
        : capabilities.allLive
          ? 'live'
          : 'mixed',
      timeMs: clock.nowMs(),
      ports: capabilities.rows.map((r) => ({
        port: r.port,
        adapter: r.adapter,
        live: r.live,
        target: r.target,
        reason: r.reason,
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
