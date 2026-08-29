/**
 * Meters `Policy.escalationDailyBudget` against a real KV-backed daily counter,
 * scenario-scoped and IST-calendar-day-scoped so a merchant sees "escalations
 * used today", not a rolling window that never resets predictably.
 *
 * Same reservation shape as `shock-detector.ts`'s `incrWithTtl` use: one atomic
 * increment-and-check, TTL set on creation, no separate INCR/EXPIRE pair for a
 * crash to land between. A KV miss or wipe (the zero-credential default) simply
 * restarts the counter at zero for the rest of the day — harmless, the same way
 * a wiped shock-suppression flag is harmless, because this is an operational
 * capacity cap, not a correctness invariant.
 *
 * Deliberately two-pass at the call site, not baked into this module: `decide()`
 * is called once unconstrained, and only when its own answer is actually the
 * escalation action does a slot get reserved here — an event that was never
 * going to escalate anyway must not spend the budget looking. See
 * `reserveEscalationSlotFor` callers in process-event.ts / process-invoice-event.ts
 * / process-abandoned-checkout.ts.
 */
import type { KvPort } from '@/ports/kv'
import { istCalendarDate } from '@/domain/ist-date'

/** One day plus a two-hour margin, so a key created just before IST midnight
 * still covers the full calendar day it was opened for even under minor clock
 * skew, and still expires on its own well before the next day's key is read. */
const BUDGET_KEY_TTL_SECONDS = 26 * 60 * 60

function budgetKey(scenarioId: string, nowMs: number): string {
  return `escalation_budget:${scenarioId}:${istCalendarDate(nowMs)}`
}

/**
 * Attempts to reserve one of today's escalation slots for `scenarioId`.
 * Returns `true` if a slot was available (the reservation counts against the
 * budget either way — a slot spent looking is still spent, the same as a real
 * ops queue where an assignment attempt has a cost even when declined).
 *
 * `dailyBudget: null` short-circuits without touching the KV at all — the
 * default, unbounded, unconstrained-policy path every published number in this
 * repository was measured against.
 */
export async function reserveEscalationSlot(
  kv: KvPort,
  scenarioId: string,
  nowMs: number,
  dailyBudget: number | null,
): Promise<boolean> {
  if (dailyBudget === null) return true
  if (dailyBudget <= 0) return false
  const usedSoFar = await kv.incrWithTtl(budgetKey(scenarioId, nowMs), BUDGET_KEY_TTL_SECONDS)
  return usedSoFar <= dailyBudget
}

/** Read-only peek at today's count, for the dashboard/operator surfaces — never
 * used to gate a decision (that path only ever goes through
 * `reserveEscalationSlot`, which is the sole place a slot is actually spent). */
export async function escalationsUsedToday(
  kv: KvPort,
  scenarioId: string,
  nowMs: number,
): Promise<number> {
  const raw = await kv.get(budgetKey(scenarioId, nowMs))
  return raw === null ? 0 : Number(raw)
}
