/**
 * Deterministic template selection (BUILD_PLAN.md §5.8 point 6): "seeded variant
 * selection" so a recorded demo shows the same text on every take, and the same
 * transaction always draws the same variant on a re-run. `stableBucket`
 * (src/domain/rng.ts) already exists for exactly this purpose — deriving a
 * stable index from an id — reused here rather than duplicated.
 *
 * This module is intentionally outside src/domain: it is language-layer
 * machinery (ESLint boundary rule 2 applies to this whole directory), not part
 * of the pure decision core, even though the selection function itself happens
 * to be pure.
 */
import { hashSeed } from '@/domain/rng'
import { WHATSAPP_NUDGE_EN, PAYMENT_LINK_EN } from './templates/nudge-en'
import { WHATSAPP_NUDGE_HI_LATN, PAYMENT_LINK_HI_LATN } from './templates/nudge-hi-latn'
import { RATIONALE_EN, RATIONALE_FORCED_ESCALATION_EN } from './templates/rationale-en'
import type { Locale } from './types'

const NUDGE_BANKS: Record<Locale, Record<'WHATSAPP_NUDGE' | 'PAYMENT_LINK', readonly string[]>> = {
  'en-IN': { WHATSAPP_NUDGE: WHATSAPP_NUDGE_EN, PAYMENT_LINK: PAYMENT_LINK_EN },
  'hi-IN-latn': { WHATSAPP_NUDGE: WHATSAPP_NUDGE_HI_LATN, PAYMENT_LINK: PAYMENT_LINK_HI_LATN },
}

/** Deterministically picks one variant from `bank`, seeded by `seedKey` — the
 * same key always yields the same variant, and picking a different bank for the
 * same key does not correlate with which index gets picked (the hash mixes the
 * bank's own size into the selection). */
function pickVariant(bank: readonly string[], seedKey: string): string {
  const index = hashSeed(seedKey) % bank.length
  const variant = bank[index]
  if (variant === undefined) throw new Error('unreachable: index derived from bank.length')
  return variant
}

export function selectNudgeTemplate(
  action: 'WHATSAPP_NUDGE' | 'PAYMENT_LINK',
  locale: Locale,
  seedKey: string,
): string {
  return pickVariant(NUDGE_BANKS[locale][action], seedKey)
}

export function selectRationaleTemplate(seedKey: string, forcedEscalation: boolean): string {
  return pickVariant(forcedEscalation ? RATIONALE_FORCED_ESCALATION_EN : RATIONALE_EN, seedKey)
}

/** `{{name}}`-style slots, filled in the order given. Distinct from
 * amount-slot.ts's `fillSlots`, which specifically handles the
 * hallucination-guarded amount and the payment link — this is the generic form,
 * used for rationale templates that have no fraud-adjacent slot to guard. */
export function fillNamedSlots(template: string, values: Readonly<Record<string, string>>): string {
  let result = template
  for (const [name, value] of Object.entries(values)) {
    result = result.split(`{{${name}}}`).join(value)
  }
  return result
}
