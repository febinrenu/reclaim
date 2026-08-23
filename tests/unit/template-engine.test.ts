import { describe, it, expect } from 'vitest'
import { selectNudgeTemplate, selectRationaleTemplate, fillNamedSlots } from '@/language/template-engine'
import { WHATSAPP_NUDGE_EN, PAYMENT_LINK_EN } from '@/language/templates/nudge-en'
import { WHATSAPP_NUDGE_HI_LATN } from '@/language/templates/nudge-hi-latn'
import { RATIONALE_EN, RATIONALE_FORCED_ESCALATION_EN } from '@/language/templates/rationale-en'

describe('every template bank has real variety, not a degenerate single entry', () => {
  it.each([
    ['WHATSAPP_NUDGE_EN', WHATSAPP_NUDGE_EN],
    ['PAYMENT_LINK_EN', PAYMENT_LINK_EN],
    ['WHATSAPP_NUDGE_HI_LATN', WHATSAPP_NUDGE_HI_LATN],
    ['RATIONALE_EN', RATIONALE_EN],
  ])('%s has at least 8 distinct variants', (_name, bank) => {
    expect(bank.length).toBeGreaterThanOrEqual(8)
    expect(new Set(bank).size).toBe(bank.length)
  })
})

describe('selectNudgeTemplate', () => {
  it('is deterministic: the same seed key always selects the same variant', () => {
    const a = selectNudgeTemplate('WHATSAPP_NUDGE', 'en-IN', 'pay_123')
    const b = selectNudgeTemplate('WHATSAPP_NUDGE', 'en-IN', 'pay_123')
    expect(a).toBe(b)
  })

  it('different seed keys are not all forced to the same variant', () => {
    const seeds = Array.from({ length: 20 }, (_, i) => `pay_${i}`)
    const selections = new Set(seeds.map((s) => selectNudgeTemplate('WHATSAPP_NUDGE', 'en-IN', s)))
    expect(selections.size).toBeGreaterThan(1)
  })

  it('selects only from the requested action and locale bank', () => {
    for (let i = 0; i < 30; i++) {
      const variant = selectNudgeTemplate('WHATSAPP_NUDGE', 'en-IN', `seed_${i}`)
      expect(WHATSAPP_NUDGE_EN).toContain(variant)
    }
  })
})

describe('selectRationaleTemplate', () => {
  it('picks from the forced-escalation bank when forced, and the normal bank otherwise', () => {
    const forced = selectRationaleTemplate('evt_1', true)
    const normal = selectRationaleTemplate('evt_1', false)
    expect(RATIONALE_FORCED_ESCALATION_EN).toContain(forced)
    expect(RATIONALE_EN).toContain(normal)
  })
})

describe('fillNamedSlots', () => {
  it('replaces every named slot, including repeats', () => {
    const result = fillNamedSlots('{{action}} chosen, {{action}} confirmed, at {{pRecoverPercent}}%', {
      action: 'RETRY_NOW',
      pRecoverPercent: '42',
    })
    expect(result).toBe('RETRY_NOW chosen, RETRY_NOW confirmed, at 42%')
  })
})
