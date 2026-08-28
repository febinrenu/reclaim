/**
 * The shared guard for `/api/dev/*`.
 *
 * Those two routes exist for a real reason: `scripts/replay.ts` and `scripts/burst.ts`
 * need to ask the running server what it has settled, and they must not open their own
 * database connection to do it — PGlite is single-process, and a second connection
 * against the same data directory is exactly the thing that corrupts an embedded store
 * rather than queueing politely. Asking the server that already holds it open is the
 * correct design.
 *
 * What was wrong: they were named "dev" and gated by nothing. A production build served
 * both, unauthenticated, and `?eventIds=` was an unbounded comma-separated list fanned
 * straight into a SQL `= ANY($1)`. Parameterised, so never an injection — but an
 * arbitrarily long array is cheap for a caller to send and not cheap for the database to
 * answer, which is amplification, and it is the kind of thing a reviewer finds in ten
 * seconds and reasonably assumes was never considered.
 *
 * Two limits, both here so the two routes cannot drift apart:
 *   1. `RECLAIM_PUBLIC_INSTANCE` turns them off entirely — a 404, not a 403, because a
 *      route that is off should not confirm it exists.
 *   2. `MAX_DEV_EVENT_IDS` caps the array on any instance, public or not. The largest
 *      real caller is `npm run replay -- --n 300`, so 500 leaves real headroom while
 *      still being a bound.
 */
import type { Env } from '@/config/env'

/** Comfortably above the largest real caller (`npm run replay -- --n 300`). */
export const MAX_DEV_EVENT_IDS = 500

export type DevRouteGuard =
  | { readonly ok: true; readonly eventIds: readonly string[] }
  | { readonly ok: false; readonly response: Response }

const NO_STORE = { 'cache-control': 'no-store' } as const

/**
 * Resolves a `/api/dev/*` request to the event ids it may be answered for, or to the
 * response that should be returned instead. `emptyBody` is what that route's own
 * "nothing asked for" answer looks like (`{ count: 0 }`, `{ rows: [] }`), so an empty
 * query keeps returning each route's real shape rather than a shared one.
 */
export function guardDevRoute(req: Request, env: Env, emptyBody: unknown): DevRouteGuard {
  if (env.RECLAIM_PUBLIC_INSTANCE) {
    return {
      ok: false,
      response: Response.json({ error: 'not found' }, { status: 404, headers: NO_STORE }),
    }
  }

  const idsParam = new URL(req.url).searchParams.get('eventIds') ?? ''
  const eventIds = idsParam.split(',').filter((s) => s.length > 0)

  if (eventIds.length === 0) {
    return { ok: false, response: Response.json(emptyBody, { headers: NO_STORE }) }
  }

  if (eventIds.length > MAX_DEV_EVENT_IDS) {
    return {
      ok: false,
      response: Response.json(
        {
          error: `too many eventIds: ${eventIds.length} requested, ${MAX_DEV_EVENT_IDS} is the maximum`,
        },
        { status: 400, headers: NO_STORE },
      ),
    }
  }

  return { ok: true, eventIds }
}
