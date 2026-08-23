import { describe, it, expect } from 'vitest'
import { dedupeByEventId } from '@/domain/dedupe'

describe('dedupeByEventId', () => {
  it('keeps exactly one entry per distinct event id, first write wins', () => {
    const items = [
      { eventId: 'a', v: 1 },
      { eventId: 'b', v: 2 },
      { eventId: 'a', v: 3 },
    ]
    expect(dedupeByEventId(items)).toEqual([
      { eventId: 'a', v: 1 },
      { eventId: 'b', v: 2 },
    ])
  })

  it('is a no-op on an already-distinct stream', () => {
    const items = [{ eventId: 'a' }, { eventId: 'b' }, { eventId: 'c' }]
    expect(dedupeByEventId(items)).toEqual(items)
  })

  it('handles the empty stream', () => {
    expect(dedupeByEventId([])).toEqual([])
  })
})
