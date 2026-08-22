import { describe, it, expect, expectTypeOf } from 'vitest'
import { assertPlain, isPlain, type Jsonish, type DataOnly } from '@/domain/json'

/**
 * These tests defend the claim that the language model can never receive a
 * money-moving client. The compile-time half is asserted with expectTypeOf; the
 * runtime half with assertPlain, for data arriving from outside the type system.
 */

// A stand-in with the shape that matters: methods, and a non-Object prototype.
class FakePaymentsClient {
  createPaymentLink(_amount: number): Promise<string> {
    return Promise.resolve('plink_live_should_never_happen')
  }
}

describe('the type-level firewall', () => {
  it('rejects a callable as Jsonish', () => {
    expectTypeOf<() => void>().not.toExtend<Jsonish>()
    expectTypeOf<Promise<string>>().not.toExtend<Jsonish>()
  })

  it('accepts plain data as Jsonish', () => {
    expectTypeOf<{ amount: number; label: string }>().toExtend<Jsonish>()
    expectTypeOf<readonly string[]>().toExtend<Jsonish>()
    expectTypeOf<null>().toExtend<Jsonish>()
  })

  it('maps a method-bearing member to never under DataOnly', () => {
    // This is what makes the argument unconstructible rather than merely discouraged:
    // there is no value a caller could supply for a field typed never.
    type Smuggled = { facts: string; client: FakePaymentsClient }
    expectTypeOf<DataOnly<Smuggled>['client']['createPaymentLink']>().toBeNever()
  })

  it('leaves plain fields untouched under DataOnly', () => {
    type Fine = { amount: number; tone: 'neutral' | 'urgent'; tags: readonly string[] }
    expectTypeOf<DataOnly<Fine>['amount']>().toBeNumber()
    expectTypeOf<DataOnly<Fine>['tone']>().toEqualTypeOf<'neutral' | 'urgent'>()
  })
})

describe('assertPlain, the runtime boundary', () => {
  it('accepts JSON primitives and nested plain structures', () => {
    expect(() => assertPlain(null)).not.toThrow()
    expect(() => assertPlain('a')).not.toThrow()
    expect(() => assertPlain(42)).not.toThrow()
    expect(() => assertPlain(true)).not.toThrow()
    expect(() => assertPlain({ a: [1, { b: 'c' }], d: null })).not.toThrow()
  })

  it('rejects a function anywhere in the structure, naming the path', () => {
    expect(() => assertPlain({ ok: 1, bad: () => 0 })).toThrow(/\$\.bad is a function/)
    expect(() => assertPlain({ deep: { list: [1, () => 0] } })).toThrow(/\$\.deep\.list\[1\]/)
  })

  it('rejects a class instance, which is how a live client would arrive', () => {
    const client = new FakePaymentsClient()
    expect(() => assertPlain({ facts: 'x', client })).toThrow(/FakePaymentsClient instance/)
    expect(() => assertPlain(client)).toThrow(/not a plain object/)
  })

  it('rejects a Map and a Date, which are not JSON despite feeling plain', () => {
    expect(() => assertPlain({ m: new Map() })).toThrow(/not a plain object/)
    expect(() => assertPlain({ d: new Date(0) })).toThrow(/not a plain object/)
  })

  it('rejects NaN and Infinity, which JSON cannot represent', () => {
    // JSON.stringify turns these into null silently, which would corrupt an audit row.
    expect(() => assertPlain({ p: Number.NaN })).toThrow(/not valid JSON/)
    expect(() => assertPlain({ p: Number.POSITIVE_INFINITY })).toThrow(/not valid JSON/)
  })

  it('rejects undefined, which is not a JSON value', () => {
    expect(() => assertPlain(undefined)).toThrow(/unsupported type undefined/)
  })

  it('fails loudly on a cyclic structure rather than hanging', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => assertPlain(cyclic)).toThrow(/likely cyclic/)
  })

  it('isPlain branches instead of throwing', () => {
    expect(isPlain({ a: 1 })).toBe(true)
    expect(isPlain(new FakePaymentsClient())).toBe(false)
    expect(isPlain(() => 0)).toBe(false)
  })
})
