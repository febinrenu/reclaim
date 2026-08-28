import { describe, it, expect } from 'vitest'
import {
  classifyEscalation,
  slaDueAtMs,
  isOverdue,
  isRecoveredResolution,
  isTerminalNegativeResolution,
  isEscalationResolution,
  ESCALATION_RESOLUTIONS,
  ESCALATION_SLA_HOURS,
} from '@/domain/escalation'

describe('classifyEscalation', () => {
  it('reports risk_gated when the gate fired', () => {
    expect(classifyEscalation({ riskGated: true, stoppingRuleHit: false })).toBe('risk_gated')
  })

  it('reports stopping_rule when retries ran out', () => {
    expect(classifyEscalation({ riskGated: false, stoppingRuleHit: true })).toBe('stopping_rule')
  })

  it('reports economic when neither forced it — escalation simply won on EV', () => {
    expect(classifyEscalation({ riskGated: false, stoppingRuleHit: false })).toBe('economic')
  })

  it('prefers risk_gated when both hold, because it is the more urgent fact', () => {
    // Both conditions genuinely co-occur: a transaction can be out of retries AND
    // risk-gated. decide() treats the gate as a hard feasibility constraint rather
    // than a cost, and this ordering matches that.
    expect(classifyEscalation({ riskGated: true, stoppingRuleHit: true })).toBe('risk_gated')
  })
})

describe('SLA', () => {
  it('is tighter for a possible-fraud review than for a collections call', () => {
    expect(ESCALATION_SLA_HOURS.risk_gated).toBeLessThan(ESCALATION_SLA_HOURS.stopping_rule)
  })

  it('is tighter for exhausted retries than for a pure judgment call', () => {
    expect(ESCALATION_SLA_HOURS.stopping_rule).toBeLessThan(ESCALATION_SLA_HOURS.economic)
  })

  it('computes a deadline from the passed-in instant, never from a read clock', () => {
    const created = 1_700_000_000_000
    expect(slaDueAtMs(created, 'risk_gated')).toBe(created + 4 * 3600_000)
    expect(slaDueAtMs(created, 'stopping_rule')).toBe(created + 24 * 3600_000)
    expect(slaDueAtMs(created, 'economic')).toBe(created + 48 * 3600_000)
  })

  it('is pure: the same inputs give the same deadline every time', () => {
    const a = slaDueAtMs(42, 'economic')
    const b = slaDueAtMs(42, 'economic')
    expect(a).toBe(b)
  })

  it('treats the deadline instant itself as not yet overdue', () => {
    const due = slaDueAtMs(0, 'risk_gated')
    expect(isOverdue(due, due)).toBe(false)
    expect(isOverdue(due, due + 1)).toBe(true)
    expect(isOverdue(due, due - 1)).toBe(false)
  })
})

describe('resolution vocabulary', () => {
  it('accepts every member and rejects anything else', () => {
    for (const r of ESCALATION_RESOLUTIONS) expect(isEscalationResolution(r)).toBe(true)
    for (const bad of ['PAID', 'paid ', '', 'settled', null, undefined, 7, {}]) {
      expect(isEscalationResolution(bad)).toBe(false)
    }
  })

  it('counts only `paid` as recovery — a promise is not a payment', () => {
    expect(isRecoveredResolution('paid')).toBe(true)
    // The whole point. Counting a promise as recovery would let the queue report money
    // that has not arrived, which is the self-flattering accounting this project exists
    // to avoid. If the promise is kept, a real payment.captured settles it once.
    expect(isRecoveredResolution('promised_to_pay')).toBe(false)
    expect(isRecoveredResolution('disputed')).toBe(false)
    expect(isRecoveredResolution('uncontactable')).toBe(false)
    expect(isRecoveredResolution('written_off')).toBe(false)
  })

  it('treats promised_to_pay as non-terminal, so no customer outcome is banked early', () => {
    expect(isTerminalNegativeResolution('promised_to_pay')).toBe(false)
    expect(isTerminalNegativeResolution('paid')).toBe(false)
    expect(isTerminalNegativeResolution('disputed')).toBe(true)
    expect(isTerminalNegativeResolution('uncontactable')).toBe(true)
    expect(isTerminalNegativeResolution('written_off')).toBe(true)
  })

  it('classifies every resolution as exactly one of recovered, terminal-negative, or pending', () => {
    // No resolution may be both, and none may be neither — otherwise
    // resolve-escalation.ts would either double-count or silently drop an outcome.
    for (const r of ESCALATION_RESOLUTIONS) {
      const recovered = isRecoveredResolution(r)
      const terminalNegative = isTerminalNegativeResolution(r)
      expect(recovered && terminalNegative).toBe(false)
      if (r === 'promised_to_pay') {
        expect(recovered || terminalNegative).toBe(false) // the one deliberate pending case
      } else {
        expect(recovered || terminalNegative).toBe(true)
      }
    }
  })
})
