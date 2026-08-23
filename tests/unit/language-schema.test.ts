import { describe, it, expect } from 'vitest'
import { parseModelOutput } from '@/language/schema'

describe('parseModelOutput', () => {
  it('parses a well-formed response', () => {
    const result = parseModelOutput('{"message":"Hi there","tone":"neutral","confidence":0.8}')
    expect(result).toEqual({ ok: true, value: { message: 'Hi there', tone: 'neutral', confidence: 0.8 } })
  })

  it('strips a markdown code fence before parsing (BUILD_PLAN.md §6.10: the single most common real-world failure)', () => {
    const fenced = '```json\n{"message":"Hi there","tone":"neutral","confidence":0.8}\n```'
    const result = parseModelOutput(fenced)
    expect(result.ok).toBe(true)
  })

  it('strips a fence with no language tag too', () => {
    const fenced = '```\n{"message":"Hi there","tone":"urgent","confidence":0.5}\n```'
    const result = parseModelOutput(fenced)
    expect(result).toEqual({ ok: true, value: { message: 'Hi there', tone: 'urgent', confidence: 0.5 } })
  })

  it('falls back on genuinely malformed JSON', () => {
    expect(parseModelOutput('{"message": "unterminated').ok).toBe(false)
  })

  it('falls back on a fenced-but-still-malformed body', () => {
    expect(parseModelOutput('```json\nnot json at all\n```').ok).toBe(false)
  })

  it('rejects a response containing an "action" key — defense in depth for "the model never decides"', () => {
    const withAction = '{"message":"Hi","tone":"neutral","confidence":0.8,"action":"RETRY_NOW"}'
    expect(parseModelOutput(withAction).ok).toBe(false)
  })

  it('rejects an invalid tone value', () => {
    expect(parseModelOutput('{"message":"Hi","tone":"angry","confidence":0.8}').ok).toBe(false)
  })

  it('rejects a confidence outside [0, 1]', () => {
    expect(parseModelOutput('{"message":"Hi","tone":"neutral","confidence":1.5}').ok).toBe(false)
  })

  it('rejects an empty message', () => {
    expect(parseModelOutput('{"message":"","tone":"neutral","confidence":0.8}').ok).toBe(false)
  })

  it('rejects extra properties strict mode should have refused', () => {
    const extra = '{"message":"Hi","tone":"neutral","confidence":0.8,"extra":"field"}'
    expect(parseModelOutput(extra).ok).toBe(false)
  })
})
