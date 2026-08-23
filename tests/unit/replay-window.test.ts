import { describe, it, expect } from 'vitest'
import { checkReplayWindow, DEFAULT_REPLAY_WINDOW } from '@/domain/webhooks/replay-window'

const NOW_MS = 1_735_689_600_000 // 2025-01-01T00:00:00Z, arbitrary fixed instant

describe('checkReplayWindow', () => {
  it('accepts an event dated exactly now', () => {
    const result = checkReplayWindow(NOW_MS / 1000, NOW_MS)
    expect(result.ok).toBe(true)
  })

  it('accepts an event within the max age', () => {
    const created = NOW_MS / 1000 - 200
    expect(checkReplayWindow(created, NOW_MS).ok).toBe(true)
  })

  it('rejects an event older than the max age (real spec bug #1, direct regression)', () => {
    const created = NOW_MS / 1000 - 301
    const result = checkReplayWindow(created, NOW_MS)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('stale')
  })

  it('rejects a missing created_at rather than silently passing (real spec bug #1)', () => {
    // The spec's own snippet computes Date.now()/1000 - undefined = NaN, and
    // `NaN > MAX_AGE` is false in JavaScript, so a missing timestamp passed the
    // staleness check silently. This is the regression test for that exact bug.
    const result = checkReplayWindow(undefined, NOW_MS)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_timestamp')
  })

  it('rejects a non-numeric created_at the same way', () => {
    expect(checkReplayWindow('not a number', NOW_MS).ok).toBe(false)
    expect(checkReplayWindow(null, NOW_MS).ok).toBe(false)
    expect(checkReplayWindow(NaN, NOW_MS).ok).toBe(false)
  })

  it('rejects an event dated implausibly in the future (real spec bug #2, direct regression)', () => {
    // The spec's check is one-sided: it only rejects stale events, never ones
    // dated in the future. A validly-signed, forged-future event would pass
    // forever under that check. This is the regression test for that exact bug.
    const created = NOW_MS / 1000 + 61
    const result = checkReplayWindow(created, NOW_MS)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('future')
  })

  it('accepts a small amount of clock skew into the future', () => {
    const created = NOW_MS / 1000 + 30
    expect(checkReplayWindow(created, NOW_MS).ok).toBe(true)
  })

  it('honours custom window options', () => {
    const created = NOW_MS / 1000 - 100
    expect(checkReplayWindow(created, NOW_MS, { maxAgeSeconds: 50, maxSkewSeconds: 10 }).ok).toBe(false)
    expect(checkReplayWindow(created, NOW_MS, DEFAULT_REPLAY_WINDOW).ok).toBe(true)
  })
})
