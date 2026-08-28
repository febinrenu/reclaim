/**
 * `PATCH /api/escalations/<id>` — the three transitions an operator can make on a work
 * item: `claim`, `release`, `resolve`.
 *
 * One route rather than three, because all three are the same shape (a conditional
 * UPDATE that either matches the expected status or does not) and splitting them would
 * mean three copies of the same rate limit, the same body parsing, and the same
 * lost-the-race handling.
 *
 * **409, not 500, when a transition is refused.** Two operators pressing Claim on the
 * same item in the same second is the ordinary case for a work queue. The database
 * settles it — exactly one caller's UPDATE matches `status = 'open'` — and the loser
 * gets a plain "someone else has it" rather than an error page.
 *
 * Rate-limited like every other unauthenticated route that writes
 * (`src/app/rate-limit.ts`). Note plainly: there is no authentication here, so
 * `assignee` is a name the caller types, not an identity the system verified.
 * SECURITY.md says so rather than leaving a reader to assume otherwise.
 */
import { getDeps } from '@/server/di'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'
import * as escalationsRepo from '@/repositories/escalations.repo'
import { resolveEscalationAndRecordOutcome } from '@/app/operator/resolve-escalation'
import { isEscalationResolution } from '@/domain/escalation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OPERATOR_RATE_LIMIT = 120
const OPERATOR_RATE_WINDOW_SECONDS = 60

/** Long enough for a real note, short enough that the column is never a dumping ground. */
const MAX_NOTE_LENGTH = 2000
const MAX_ASSIGNEE_LENGTH = 120

interface RequestBody {
  readonly op?: unknown
  readonly assignee?: unknown
  readonly resolution?: unknown
  readonly note?: unknown
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** Trims, and treats an all-whitespace value as absent rather than as a real string. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > max ? undefined : trimmed
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Next 16: `params` is async-only (AGENTS.md / BUILD_PLAN.md C7).
  const { id } = await ctx.params
  const deps = await getDeps()

  const rateLimit = await checkRateLimit(
    deps.kv,
    'operator',
    clientKeyFrom(req),
    OPERATOR_RATE_LIMIT,
    OPERATOR_RATE_WINDOW_SECONDS,
  )
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

  const nowMs = deps.clock.nowMs()

  if (body.op === 'claim') {
    const assignee = optionalText(body.assignee, MAX_ASSIGNEE_LENGTH)
    if (assignee === undefined) {
      return json({ error: `assignee must be a string of at most ${MAX_ASSIGNEE_LENGTH} characters` }, 400)
    }
    // Unauthenticated, so there is no verified identity to fall back on. Named
    // 'unattributed' rather than left null so the audit trail says plainly that
    // nobody put their name to it.
    const claimed = await escalationsRepo.claimEscalation(
      deps.sql,
      id,
      assignee ?? 'unattributed',
      nowMs,
    )
    if (claimed === null) {
      return json({ error: 'this item is no longer open — someone else claimed or resolved it' }, 409)
    }
    return json({ escalation: serialize(claimed) })
  }

  if (body.op === 'release') {
    const released = await escalationsRepo.releaseEscalation(deps.sql, id)
    if (released === null) {
      return json({ error: 'this item is not currently claimed' }, 409)
    }
    return json({ escalation: serialize(released) })
  }

  if (body.op === 'resolve') {
    if (!isEscalationResolution(body.resolution)) {
      return json(
        { error: 'resolution must be one of: paid, promised_to_pay, disputed, uncontactable, written_off' },
        400,
      )
    }
    const note = optionalText(body.note, MAX_NOTE_LENGTH)
    if (note === undefined) {
      return json({ error: `note must be a string of at most ${MAX_NOTE_LENGTH} characters` }, 400)
    }

    const result = await resolveEscalationAndRecordOutcome(deps.sql, {
      id,
      resolution: body.resolution,
      note,
      nowMs,
    })
    if (!result.ok) {
      return json({ error: 'this item must be claimed before it can be resolved' }, 409)
    }
    return json({ escalation: serialize(result.escalation) })
  }

  return json({ error: "op must be one of: claim, release, resolve" }, 400)
}

/** Dates as ISO strings, `bigint` as a number — the same contract other routes use. */
function serialize(row: escalationsRepo.EscalationRow) {
  return {
    id: row.id,
    eventId: row.eventId,
    transactionId: row.transactionId,
    customerId: row.customerId,
    amountPaise: row.amountPaise,
    reason: row.reason,
    riskScore: row.riskScore,
    rationale: row.rationale,
    status: row.status,
    assignee: row.assignee,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    slaDueAt: row.slaDueAt.toISOString(),
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
