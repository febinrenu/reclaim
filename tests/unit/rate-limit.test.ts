import { describe, it, expect } from 'vitest'
import { createMemoryKv } from '@/adapters/kv/memory'
import { checkRateLimit, clientKeyFrom } from '@/app/rate-limit'

describe('checkRateLimit', () => {
  it('allows up to the limit, then rejects', async () => {
    const kv = createMemoryKv()
    for (let i = 1; i <= 3; i++) {
      const r = await checkRateLimit(kv, 'test', 'client-a', 3, 60)
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(3 - i)
    }
    const over = await checkRateLimit(kv, 'test', 'client-a', 3, 60)
    expect(over.allowed).toBe(false)
    expect(over.remaining).toBe(0)
  })

  it('tracks separate clients independently', async () => {
    const kv = createMemoryKv()
    for (let i = 0; i < 3; i++) await checkRateLimit(kv, 'test', 'client-a', 3, 60)
    // client-a is now at its limit; client-b must be unaffected.
    const b = await checkRateLimit(kv, 'test', 'client-b', 3, 60)
    expect(b.allowed).toBe(true)
  })

  it('tracks separate key prefixes independently, so /batches and /simulate never share a bucket', async () => {
    const kv = createMemoryKv()
    for (let i = 0; i < 3; i++) await checkRateLimit(kv, 'batches', 'same-client', 3, 60)
    const simulate = await checkRateLimit(kv, 'simulate', 'same-client', 3, 60)
    expect(simulate.allowed).toBe(true)
  })
})

describe('clientKeyFrom', () => {
  it('reads the first hop of x-forwarded-for', () => {
    const req = new Request('http://localhost/', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } })
    expect(clientKeyFrom(req)).toBe('1.2.3.4')
  })

  it('falls back to a shared bucket when the header is absent, never throwing', () => {
    const req = new Request('http://localhost/')
    expect(clientKeyFrom(req)).toBe('unknown')
  })
})
