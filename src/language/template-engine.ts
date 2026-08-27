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
import { SEND_REMINDER_EN, OFFER_PAYMENT_PLAN_EN } from './templates/reminder-en'
import { RATIONALE_EN, RATIONALE_FORCED_ESCALATION_EN, RATIONALE_SHOCK_SUPPRESSED_EN } from './templates/rationale-en'
import type { Locale } from './types'

export type NudgeAction = 'WHATSAPP_NUDGE' | 'PAYMENT_LINK' | 'SEND_REMINDER' | 'OFFER_PAYMENT_PLAN'

/**
 * `SEND_REMINDER`/`OFFER_PAYMENT_PLAN` (the B2B receivables chaser's two
 * contact-requiring actions, `reminder-en.ts`) join the bank here — real live
 * wiring, closing the gap `reminder-en.ts`'s own docstring named directly
 * ("committed and parity-checked... but not yet wired into
 * `selectNudgeTemplate`'s bank lookup"). No Hindi-transliteration bank exists
 * for B2B's copy yet, so it falls back to the English bank for that locale
 * rather than pretending a translation exists — same honesty as everywhere
 * else a real gap gets named instead of silently worked around.
 */
const NUDGE_BANKS: Record<Locale, Record<NudgeAction, readonly string[]>> = {
  'en-IN': {
    WHATSAPP_NUDGE: WHATSAPP_NUDGE_EN,
    PAYMENT_LINK: PAYMENT_LINK_EN,
    SEND_REMINDER: SEND_REMINDER_EN,
    OFFER_PAYMENT_PLAN: OFFER_PAYMENT_PLAN_EN,
  },
  'hi-IN-latn': {
    WHATSAPP_NUDGE: WHATSAPP_NUDGE_HI_LATN,
    PAYMENT_LINK: PAYMENT_LINK_HI_LATN,
    SEND_REMINDER: SEND_REMINDER_EN,
    OFFER_PAYMENT_PLAN: OFFER_PAYMENT_PLAN_EN,
  },
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
  action: NudgeAction,
  locale: Locale,
  seedKey: string,
): string {
  return pickVariant(NUDGE_BANKS[locale][action], seedKey)
}

export function selectRationaleTemplate(
  seedKey: string,
  opts: { readonly forcedEscalation: boolean; readonly shockSuppressed?: boolean },
): string {
  const bank = opts.forcedEscalation
    ? RATIONALE_FORCED_ESCALATION_EN
    : opts.shockSuppressed === true
      ? RATIONALE_SHOCK_SUPPRESSED_EN
      : RATIONALE_EN
  return pickVariant(bank, seedKey)
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
