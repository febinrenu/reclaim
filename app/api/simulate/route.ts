/**
 * `POST /api/simulate` — the policy simulator's HTTP surface. Reads a stored
 * batch, replays it offline under a varied policy, and returns the diff.
 * Nothing here writes to the database — see run-simulation.ts's own docstring
 * for exactly what "zero audit rows, zero executor calls" means structurally.
 */
import { getDeps } from '@/server/di'
import { runSimulation, type PolicyOverrides } from '@/app/simulate/run-simulation'
import { serializeSimulationResult } from '@/app/simulate/serialize'
import type { SubscriptionAction } from '@/domain/scenario/subscription'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RequestBody {
  readonly batchId?: unknown
  readonly interventionCostRupees?: unknown
  readonly riskThreshold?: unknown
}

// Lighter-weight than a batch run (pure re-computation over stored rows, zero
// writes — see this file's own header comment) but still unauthenticated and
// still real database reads per call, so still worth a real ceiling.
const SIMULATE_RATE_LIMIT = 20
const SIMULATE_RATE_WINDOW_SECONDS = 300

export async function POST(req: Request): Promise<Response> {
  const deps = await getDeps()

  const rateLimit = await checkRateLimit(deps.kv, 'simulate', clientKeyFrom(req), SIMULATE_RATE_LIMIT, SIMULATE_RATE_WINDOW_SECONDS)
  if (!rateLimit.allowed) {
    return new Response('rate limit exceeded, try again shortly', {
      status: 429,
      headers: { 'retry-after': String(rateLimit.retryAfterSeconds) },
    })
  }

  let body: RequestBody
  try {
    body = (await req.json()) as RequestBody
  } catch {
    return new Response('malformed JSON body', { status: 400 })
  }

  if (typeof body.batchId !== 'string' || body.batchId === '') {
    return new Response('batchId is required', { status: 400 })
  }

  let interventionCostRupees: Partial<Record<SubscriptionAction, number>> | undefined
  if (typeof body.interventionCostRupees === 'object' && body.interventionCostRupees !== null) {
    const entries = Object.entries(body.interventionCostRupees as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === 'number',
    )
    interventionCostRupees = Object.fromEntries(entries) as Partial<Record<SubscriptionAction, number>>
  }
  const overrides: PolicyOverrides = {
    ...(interventionCostRupees !== undefined ? { interventionCostRupees } : {}),
    ...(typeof body.riskThreshold === 'number' ? { riskThreshold: body.riskThreshold } : {}),
  }

  const result = await runSimulation(deps, body.batchId, overrides)
  return Response.json(serializeSimulationResult(result))
}
