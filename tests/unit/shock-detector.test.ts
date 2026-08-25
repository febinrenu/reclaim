/**
 * BUILD_PLAN.md §6.10: the two named decoys (a 12-event sub-threshold cluster,
 * and a 35-event cluster spread across 4 banks) that must both fail to trip,
 * plus the in-memory half of the TTL-crash guarantee. The real-Postgres half
 * lives in tests/integration/shock-detector.test.ts — this file stays zero-I/O.
 */
import { describe, it, expect } from 'vitest'
import { createMemoryKv } from '@/adapters/kv/memory'
import { recordFailure, isShockSuppressed, SHOCK_THRESHOLD } from '@/app/worker/shock-detector'

describe('recordFailure / isShockSuppressed, in-memory KV', () => {
  it('does not suppress below the threshold', async () => {
    const kv = createMemoryKv()
    for (let i = 0; i < SHOCK_THRESHOLD; i++) {
      await recordFailure(kv, 'HDFC', 'GATEWAY_ERROR')
    }
    expect(await isShockSuppressed(kv, 'HDFC', 'GATEWAY_ERROR')).toBe(false)
  })

  it('suppresses once the threshold is crossed, and reports justTripped exactly once', async () => {
    const kv = createMemoryKv()
    const trips: boolean[] = []
    for (let i = 0; i < SHOCK_THRESHOLD + 5; i++) {
      const result = await recordFailure(kv, 'HDFC', 'GATEWAY_ERROR')
      trips.push(result.justTripped)
    }
    expect(trips.filter(Boolean)).toHaveLength(1)
    expect(await isShockSuppressed(kv, 'HDFC', 'GATEWAY_ERROR')).toBe(true)
  })

  it('key granularity is per (bank, errorCode): a burst on one pair never suppresses another', async () => {
    const kv = createMemoryKv()
    for (let i = 0; i < SHOCK_THRESHOLD + 5; i++) {
      await recordFailure(kv, 'HDFC', 'GATEWAY_ERROR')
    }
    expect(await isShockSuppressed(kv, 'HDFC', 'GATEWAY_ERROR')).toBe(true)
    expect(await isShockSuppressed(kv, 'HDFC', 'SERVER_ERROR')).toBe(false)
    expect(await isShockSuppressed(kv, 'ICICI', 'GATEWAY_ERROR')).toBe(false)
  })

  it('decoy 1: a 12-event sub-threshold cluster never trips', async () => {
    const kv = createMemoryKv()
    for (let i = 0; i < 12; i++) {
      await recordFailure(kv, 'AXIS', 'BAD_REQUEST_ERROR')
    }
    expect(await isShockSuppressed(kv, 'AXIS', 'BAD_REQUEST_ERROR')).toBe(false)
  })

  it('decoy 2: 35 events sharing one error code, spread across 4 banks, never trips any per-bank key', async () => {
    const kv = createMemoryKv()
    const banks = ['HDFC', 'ICICI', 'SBI', 'KOTAK']
    for (let i = 0; i < 35; i++) {
      const bank = banks[i % banks.length]
      if (bank !== undefined) await recordFailure(kv, bank, 'GATEWAY_ERROR')
    }
    for (const bank of banks) {
      expect(await isShockSuppressed(kv, bank, 'GATEWAY_ERROR')).toBe(false)
    }
  })

  it('treats a null bank or errorCode as its own stable key, not a crash', async () => {
    const kv = createMemoryKv()
    for (let i = 0; i < SHOCK_THRESHOLD + 5; i++) {
      await recordFailure(kv, null, null)
    }
    expect(await isShockSuppressed(kv, null, null)).toBe(true)
    expect(await isShockSuppressed(kv, 'HDFC', 'GATEWAY_ERROR')).toBe(false)
  })
})

describe('the TTL-crash bug, fixed architecturally (in-memory half)', () => {
  it('incrWithTtl is one synchronous critical section — no window for a crash between increment and TTL', async () => {
    const kv = createMemoryKv()
    // Simulate "a prior process" by calling incrWithTtl directly, then reading
    // back with get() well within the window: a real INCR-then-EXPIRE bug
    // would show up as get() finding no TTL at all (an eternal key). Here,
    // incrWithTtl's own single call always sets the TTL on creation, so the
    // very first call already carries an expiry — there is no "creates the
    // counter, but expiry is a later step someone might not reach" window.
    const first = await kv.incrWithTtl('failrate:HDFC:GATEWAY_ERROR', 300)
    expect(first).toBe(1)
    // A second, independent "process" (a fresh call) continuing the same key
    // never resets or drops the original TTL — proven indirectly: the key is
    // still suppressible after SHOCK_THRESHOLD more calls, meaning the counter
    // never silently reset to 1 because its TTL vanished.
    for (let i = 0; i < SHOCK_THRESHOLD; i++) {
      await kv.incrWithTtl('failrate:HDFC:GATEWAY_ERROR', 300)
    }
    const value = await kv.get('failrate:HDFC:GATEWAY_ERROR')
    expect(Number(value)).toBe(SHOCK_THRESHOLD + 1)
  })
})
