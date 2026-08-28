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
 *
 * The one thing it does NOT publish on a public instance is each row's `target`.
 * Locally that field is the useful half — it names the PGlite directory, the Groq
 * model, the Postgres host. On a public URL it was disclosing a real Supabase
 * hostname and a real Upstash hostname to any unauthenticated caller, which is free
 * reconnaissance and no part of what this endpoint is for. `RECLAIM_PUBLIC_INSTANCE`
 * drops it; every other field, including `live` and the human-readable `reason`,
 * still comes through, so the endpoint keeps answering the question it exists to
 * answer.
 */
export async function GET() {
  const { capabilities, clock, env } = await getDeps()
  const disclose = !env.RECLAIM_PUBLIC_INSTANCE

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
        // `reason` stays: it is written for a human and names no host, key, or path.
        // `target` is the field that named real infrastructure, so it is the field
        // that goes.
        reason: r.reason,
        ...(disclose ? { target: r.target } : {}),
      })),
      ...(disclose ? {} : { note: "per-port 'target' withheld: RECLAIM_PUBLIC_INSTANCE is set" }),
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
