/**
 * Checkout abandonment end to end, against real PGlite.
 *
 * The scenario unit tests pin what the menu contains; these pin that a real abandoned
 * order actually flows through the engine and leaves the same evidence trail every other
 * input does — a transaction, an intent, an audit row, and an escalation when one is
 * warranted. That is the claim this scenario exists to support: the decision machinery
 * generalises to a third input shape without being modified.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createMemoryKv } from '@/adapters/kv/memory'
import { createPaymentsSimulator } from '@/adapters/payments/simulator'
import { runMigrations } from '@/db/migrate'
import { loadEnv } from '@/config/env'
import { buildContainer, type Deps } from '@/config/container'
import { fixedClock } from '@/domain/clock'
import { processAbandonedCheckout } from '@/app/checkout/process-abandoned-checkout'
import { CHECKOUT_ACTIONS } from '@/domain/scenario/checkout'
import * as escalationsRepo from '@/repositories/escalations.repo'
import { eventId as toEventId } from '@/domain/ids'
import type { Transactional } from '@/ports/sql'

function uid(p: string): string {
  return `${p}_${crypto.randomUUID()}`
}

describe('abandoned checkout, end to end', () => {
  let dir: string
  let sql: Transactional
  let deps: Deps
  const nowMs = 1_756_000_000_000

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-checkout-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)
    deps = await buildContainer(loadEnv({}), {
      sql,
      kv: createMemoryKv(),
      clock: fixedClock(nowMs),
      payments: createPaymentsSimulator('test_secret'),
      webhookSecret: 'test_secret',
    })
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function input(over: Record<string, unknown> = {}) {
    return {
      eventId: uid('evt_cart'),
      orderId: uid('order'),
      customerId: uid('cust'),
      amountPaise: 250_00,
      minutesSinceCreated: 45,
      orderStatus: 'created' as const,
      ...over,
    }
  }

  it('decides on an abandoned order and leaves a full evidence trail', async () => {
    const i = input()
    const result = await processAbandonedCheckout(deps, i)

    expect(result.duplicate).toBe(false)
    expect(CHECKOUT_ACTIONS as readonly string[]).toContain(result.chosenAction)
    // Never a retry: no charge was ever attempted against anything.
    expect(result.chosenAction).not.toBe('RETRY_NOW')
    expect(result.chosenAction).not.toBe('RETRY_LATER')
    expect(result.evMilli).not.toBeNull()

    const txn = await sql.query<{ status: string; scenario: string; amount_paise: string | number }>(
      'SELECT status, scenario, amount_paise FROM transactions WHERE id = $1',
      [i.orderId],
    )
    expect(txn.rows[0]?.scenario).toBe('checkout_abandonment')
    expect(Number(txn.rows[0]?.amount_paise)).toBe(250_00)

    const audit = await sql.query<{ chosen_action: string }>(
      'SELECT chosen_action FROM recovery_audit WHERE event_id = $1',
      [i.eventId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.chosen_action).toBe(result.chosenAction)

    const intent = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM action_attempts WHERE event_id = $1',
      [i.eventId],
    )
    expect(Number(intent.rows[0]?.count)).toBe(1)
  })

  it('is idempotent on the event id, so a repeated sweep decides once', async () => {
    const i = input()
    const first = await processAbandonedCheckout(deps, i)
    const second = await processAbandonedCheckout(deps, i)

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)

    const audit = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = $1',
      [i.eventId],
    )
    expect(Number(audit.rows[0]?.count)).toBe(1)
  })

  it('short-circuits a cart that converted, banking the outcome exactly once', async () => {
    const i = input({ paid: true, amountPaise: 900_00 })
    const result = await processAbandonedCheckout(deps, i)

    expect(result.chosenAction).toBe('PAID')
    // No decision was priced, because there was nothing left to decide.
    const audit = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM recovery_audit WHERE event_id = $1',
      [i.eventId],
    )
    expect(Number(audit.rows[0]?.count)).toBe(0)

    const txn = await sql.query<{ status: string }>('SELECT status FROM transactions WHERE id = $1', [i.orderId])
    expect(txn.rows[0]?.status).toBe('recovered')

    const cust = await sql.query<{ successful_payments: number; ltv_amount_paise: string | number }>(
      'SELECT successful_payments, ltv_amount_paise FROM customers WHERE id = $1',
      [i.customerId],
    )
    expect(cust.rows[0]?.successful_payments).toBe(1)
    expect(Number(cust.rows[0]?.ltv_amount_paise)).toBe(900_00)
  })

  it('routes an escalated cart into the same operator queue as everything else', async () => {
    // A large enough amount that a ₹40 human clears the bar on expected value.
    const i = input({ amountPaise: 500_000_00 })
    const result = await processAbandonedCheckout(deps, i)
    expect(result.chosenAction).toBe('ESCALATE_HUMAN')
    expect(result.escalationId).not.toBeNull()

    // One queue, not a second one that would need its own triage.
    const work = await escalationsRepo.findByEvent(sql, toEventId(i.eventId), 1)
    expect(work).not.toBeNull()
    expect(work?.status).toBe('open')
    expect(work?.amountPaise).toBe(500_000_00)
    expect(work?.rationale).toContain('Abandoned checkout')
  })

  it('counts a chase rather than a charge, and stops after the cap', async () => {
    // This describe block's own shared clock (05:46 IST) sits inside quiet hours, which
    // now correctly blocks the two chase actions (WHATSAPP_NUDGE, PAYMENT_LINK) — so a
    // small cart with no reachable contact channel and no cap-worthy amount would
    // otherwise sit at DO_NOTHING forever and never accumulate a chase count at all.
    // That is the right answer for quiet hours; it is not what this test is about, so
    // it gets its own daytime clock instead.
    const daytimeMs = nowMs + 13 * 3600_000 // 05:46 IST + 13h == 18:46 IST
    const daytimeDeps = await buildContainer(loadEnv({}), {
      sql,
      kv: createMemoryKv(),
      clock: fixedClock(daytimeMs),
      payments: createPaymentsSimulator('test_secret'),
      webhookSecret: 'test_secret',
    })

    const orderId = uid('order_capped')
    const customerId = uid('cust_capped')
    const actions: string[] = []
    // Five sweeps over one stubbornly unpaid cart.
    for (let n = 0; n < 5; n++) {
      const r = await processAbandonedCheckout(
        daytimeDeps,
        input({ eventId: uid('evt_capped'), orderId, customerId, amountPaise: 400_00 }),
      )
      actions.push(r.chosenAction)
    }
    // Once the chase cap is reached the stopping rule allows only escalation, so the
    // system stops nudging rather than chasing the same cart forever.
    expect(actions[actions.length - 1]).toBe('ESCALATE_HUMAN')

    const txn = await sql.query<{ retry_count: number }>(
      'SELECT retry_count FROM transactions WHERE id = $1',
      [orderId],
    )
    // Capped, never overshooting — the same atomic statement the subscription path uses.
    expect(txn.rows[0]?.retry_count).toBeLessThanOrEqual(3)
  })
})
