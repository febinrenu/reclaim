/**
 * Zero-I/O half against the in-memory KV, mirroring shock-detector.test.ts's
 * split: the real-Postgres/Upstash-shaped behaviour is exercised wherever the
 * worker integration tests already run a full `processEvent`, not duplicated
 * here.
 */
import { describe, it, expect } from 'vitest'
import { createMemoryKv } from '@/adapters/kv/memory'
import { reserveEscalationSlot, escalationsUsedToday } from '@/app/worker/escalation-budget'

const NOW = Date.parse('2026-08-29T10:00:00Z')

describe('reserveEscalationSlot', () => {
  it('never touches the KV when the budget is unbounded (null)', async () => {
    const kv = createMemoryKv()
    expect(await reserveEscalationSlot(kv, 'subscription', NOW, null)).toBe(true)
    expect(await escalationsUsedToday(kv, 'subscription', NOW)).toBe(0)
  })

  it('rejects immediately when the budget is zero, without incrementing', async () => {
    const kv = createMemoryKv()
    expect(await reserveEscalationSlot(kv, 'subscription', NOW, 0)).toBe(false)
    expect(await escalationsUsedToday(kv, 'subscription', NOW)).toBe(0)
  })

  it('grants exactly `budget` slots, then rejects the rest', async () => {
    const kv = createMemoryKv()
    const budget = 3
    const results: boolean[] = []
    for (let i = 0; i < budget + 2; i++) {
      results.push(await reserveEscalationSlot(kv, 'subscription', NOW, budget))
    }
    expect(results).toEqual([true, true, true, false, false])
    expect(await escalationsUsedToday(kv, 'subscription', NOW)).toBe(budget + 2)
  })

  it('scopes the counter per scenario — one scenario spending its budget never blocks another', async () => {
    const kv = createMemoryKv()
    await reserveEscalationSlot(kv, 'subscription', NOW, 1)
    expect(await reserveEscalationSlot(kv, 'subscription', NOW, 1)).toBe(false)
    expect(await reserveEscalationSlot(kv, 'b2b_receivable', NOW, 1)).toBe(true)
  })

  it('resets on the next IST calendar day', async () => {
    const kv = createMemoryKv()
    await reserveEscalationSlot(kv, 'subscription', NOW, 1)
    expect(await reserveEscalationSlot(kv, 'subscription', NOW, 1)).toBe(false)

    const nextDay = NOW + 25 * 60 * 60 * 1000
    expect(await reserveEscalationSlot(kv, 'subscription', nextDay, 1)).toBe(true)
  })
})
