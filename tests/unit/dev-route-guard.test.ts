import { describe, it, expect } from 'vitest'
import { guardDevRoute, MAX_DEV_EVENT_IDS } from '@/app/dev-route-guard'
import { loadEnv } from '@/config/env'

/** A real parsed Env, built from an explicit source so no test reads process.env. */
function env(overrides: Record<string, string> = {}) {
  return loadEnv({ ...overrides })
}

const req = (query = '') => new Request(`http://localhost/api/dev/audit-count${query}`)

describe('guardDevRoute', () => {
  it('answers normally on a local instance', () => {
    const guard = guardDevRoute(req('?eventIds=evt_1,evt_2'), env(), { count: 0 })
    expect(guard.ok).toBe(true)
    if (guard.ok) expect(guard.eventIds).toEqual(['evt_1', 'evt_2'])
  })

  it('404s on a public instance, without confirming the route exists', async () => {
    const guard = guardDevRoute(
      req('?eventIds=evt_1'),
      env({ RECLAIM_PUBLIC_INSTANCE: '1' }),
      { count: 0 },
    )
    expect(guard.ok).toBe(false)
    if (!guard.ok) {
      expect(guard.response.status).toBe(404)
      // Not a 403: a route that is switched off should not advertise itself.
      await expect(guard.response.json()).resolves.toEqual({ error: 'not found' })
    }
  })

  it('accepts `true` as well as `1` for the flag, so a .env reads naturally', () => {
    const guard = guardDevRoute(req('?eventIds=evt_1'), env({ RECLAIM_PUBLIC_INSTANCE: 'true' }), {
      count: 0,
    })
    expect(guard.ok).toBe(false)
  })

  it('returns the route\'s own empty shape when nothing is asked for', async () => {
    const count = guardDevRoute(req(''), env(), { count: 0 })
    expect(count.ok).toBe(false)
    if (!count.ok) {
      expect(count.response.status).toBe(200)
      await expect(count.response.json()).resolves.toEqual({ count: 0 })
    }

    // The other route's empty answer is a different shape, and must stay that shape.
    const rows = guardDevRoute(req(''), env(), { rows: [] })
    if (!rows.ok) await expect(rows.response.json()).resolves.toEqual({ rows: [] })
  })

  it('caps the id list on any instance, public or not', async () => {
    const ids = Array.from({ length: MAX_DEV_EVENT_IDS + 1 }, (_, i) => `evt_${i}`).join(',')
    const guard = guardDevRoute(req(`?eventIds=${ids}`), env(), { count: 0 })
    expect(guard.ok).toBe(false)
    if (!guard.ok) {
      expect(guard.response.status).toBe(400)
      const body = (await guard.response.json()) as { error: string }
      expect(body.error).toContain(String(MAX_DEV_EVENT_IDS))
    }
  })

  it('allows exactly the cap, so the bound is inclusive and the real caller fits', () => {
    const ids = Array.from({ length: MAX_DEV_EVENT_IDS }, (_, i) => `evt_${i}`).join(',')
    const guard = guardDevRoute(req(`?eventIds=${ids}`), env(), { count: 0 })
    expect(guard.ok).toBe(true)
    if (guard.ok) expect(guard.eventIds).toHaveLength(MAX_DEV_EVENT_IDS)
  })

  it('leaves the largest real caller (npm run replay -- --n 300) comfortably inside the cap', () => {
    expect(MAX_DEV_EVENT_IDS).toBeGreaterThan(300)
  })

  it('drops empty segments rather than passing a blank id to SQL', () => {
    const guard = guardDevRoute(req('?eventIds=evt_1,,evt_2,'), env(), { count: 0 })
    expect(guard.ok).toBe(true)
    if (guard.ok) expect(guard.eventIds).toEqual(['evt_1', 'evt_2'])
  })
})
