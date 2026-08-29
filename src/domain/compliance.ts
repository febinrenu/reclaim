/**
 * Two hard contact constraints — quiet hours and a per-customer contact cap —
 * neither of which existed before: the only limit on contact volume was
 * `contactFatigueCost` (`src/domain/ev.ts`), a cost a large enough amount can
 * always out-compete, the same reason the risk gate and the escalation budget
 * are feasibility constraints rather than costs (`src/domain/decide.ts`'s own
 * header). "No unsolicited messages" and "compliant escalation" (README's
 * constraints, and Track 03's own bar) deserve the same treatment.
 *
 * **Deliberately NOT plumbed through `decide()` as new `DecisionInput`
 * fields, unlike the escalation budget.** Both facts are folded into
 * `capabilityAvailable` at the live call sites instead, reusing the existing
 * `capability_missing`/`no_contact` reasons `decide()` already has for "this
 * channel cannot be used right now" (a phone number missing is not a
 * different kind of fact than "the clock says do not contact this person
 * right now"). The reason is nowMs: this whole codebase's test suite —
 * hundreds of unit and property cases across `tests/unit/decide.test.ts` and
 * `tests/property/decide.property.test.ts` — fixes `nowMs` at values like `0`
 * (05:30 IST) with no awareness that a wall-clock rule might exist, because
 * none did. Baking quiet hours into `decide()`'s pure core would silently
 * reinterpret every one of those fixed instants against real India Standard
 * Time, which is a correctness change no test was written to anticipate.
 * Keeping the wall-clock read here, at the boundary that already computes
 * live facts (`buildLiveFeatures` and its siblings), makes it a fact `decide()`
 * consumes the same inert way it consumes "no phone on file" — real in the
 * live paths, absent in every existing fixed-clock test, and never entangled
 * with `decide()`'s own purity guarantee.
 */
import { istHourOfDay } from './ist-date'

/** 21:00-09:00 IST — most Indian consumer-messaging guidance (and TRAI's own
 * commercial-communication framework) treats this window as off-limits for
 * unsolicited contact. Applied here to every contact-requiring action, not
 * only WhatsApp/SMS specifically, since a Payment Link notification is the
 * same kind of unsolicited contact. */
export const QUIET_HOURS_START_IST = 21
export const QUIET_HOURS_END_IST = 9

export function isQuietHoursIst(nowMs: number): boolean {
  const hour = istHourOfDay(nowMs)
  return hour >= QUIET_HOURS_START_IST || hour < QUIET_HOURS_END_IST
}

/** A customer already contacted `capPerWindow` times in the window `contactsInWindow`
 * counts (7 days for subscription/checkout, 14 for B2B — each scenario's own
 * existing window) gets no further contact this cycle, regardless of how large the
 * failed amount is. Distinct from `contactFatigueCost`: fatigue prices repeated
 * contact into the EV; this is a hard ceiling that no amount can buy past. */
export function exceedsContactCap(contactsInWindow: number, capPerWindow: number): boolean {
  return contactsInWindow >= capPerWindow
}

/** `ALL_CAPABLE`, except every contact-requiring action is forced unavailable
 * when `contactBlocked` is true — the shape `decide()` already expects for
 * "this channel is down right now", reused rather than given a parallel
 * mechanism. */
export function capabilityRespectingCompliance<A extends string>(
  actions: readonly A[],
  requiresContact: (action: A) => boolean,
  contactBlocked: boolean,
): Readonly<Record<A, boolean>> {
  return Object.fromEntries(actions.map((a) => [a, requiresContact(a) ? !contactBlocked : true])) as Record<
    A,
    boolean
  >
}
