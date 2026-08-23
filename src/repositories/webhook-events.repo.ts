/**
 * The idempotency authority (BUILD_PLAN.md §5.1 A1). `insertIfAbsent` is the whole of
 * it: a UNIQUE primary key checked with `ON CONFLICT ... DO NOTHING` inside the same
 * transaction as the rest of T1's write, so a lock and a write can never disagree
 * about whether an event already arrived.
 */
import type { SqlExecutor } from '@/ports/sql'
import { eventId, type EventId } from '@/domain/ids'
import type { Jsonish } from '@/domain/json'

export interface WebhookEventRow {
  readonly eventId: EventId
  readonly eventType: string
  readonly payload: Jsonish
  readonly receivedAt: Date
}

interface WebhookEventDbRow {
  event_id: string
  event_type: string
  payload: Jsonish
  received_at: Date
}

function toRow(r: WebhookEventDbRow): WebhookEventRow {
  return { eventId: eventId(r.event_id), eventType: r.event_type, payload: r.payload, receivedAt: r.received_at }
}

/** True when this call is the one that inserted the row — i.e. a genuinely new event. */
export async function insertIfAbsent(
  sql: SqlExecutor,
  input: { readonly eventId: EventId; readonly eventType: string; readonly payload: Jsonish },
): Promise<boolean> {
  const { rows } = await sql.query<{ inserted: boolean }>(
    `INSERT INTO webhook_events (event_id, event_type, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING true AS inserted`,
    [input.eventId, input.eventType, JSON.stringify(input.payload)],
  )
  return rows.length > 0
}

export async function findWebhookEvent(
  sql: SqlExecutor,
  id: EventId,
): Promise<WebhookEventRow | null> {
  const { rows } = await sql.query<WebhookEventDbRow>(
    'SELECT * FROM webhook_events WHERE event_id = $1',
    [id],
  )
  return rows[0] === undefined ? null : toRow(rows[0])
}
