/**
 * Checkout abandonment — the third input this engine decides on, and the last of the
 * three Track 03 names ("from payment failures and checkout abandonment to overdue
 * receivables"). Payment failures and receivables were already covered; this one was not.
 *
 * **This scenario is a restriction of the subscription scenario, not a new one.** It
 * reuses that scenario's trained model, feature order and `buildModelRow` verbatim by
 * spreading it, and changes exactly two things: the action set and the policy. That is
 * the honest shape of the difference — an abandoned checkout is the same decision problem
 * with a smaller menu.
 *
 * **`RETRY_NOW` and `RETRY_LATER` are removed, and this is the substantive part.** There
 * is nothing to retry: an abandoned checkout is an order that was created and never paid,
 * so no charge was ever attempted against any instrument. Retrying a payment that does
 * not exist is not a conservative choice, it is a meaningless one, and leaving those two
 * in the menu would let the argmax pick them — which on the subscription scorer it often
 * would, since they cost ₹0. Removing them from `actions` is the right lever because
 * `decide()` maps over exactly that array; `capabilityAvailable` would not work here,
 * since it only gates actions where `requiresContact` is true.
 *
 * **`WHATSAPP_NUDGE` is removed too, for a different reason: the borrowed probability
 * below is least trustworthy exactly where it would have to make this call.** Choosing
 * *between* a soft reminder and a payment link is a fine distinction the scorer was never
 * trained to make — its coefficients describe what makes a declined charge recover, not
 * what makes an abandoned cart complete, and the two contact actions differ from each
 * other by amounts small enough that miscalibration is exactly the kind of noise that
 * could flip which one wins. `PAYMENT_LINK` is also the strictly more capable action for
 * this scenario on its own terms, with no probability needed to justify it: it both
 * reminds *and* gives a completion path a nudge alone does not, at the same ₹0.35 cost.
 * Keeping only one contact action does not fix the underlying calibration gap — the
 * escalate-or-not and act-or-not decisions are still driven by the same borrowed number —
 * but it removes the one choice this scorer had no business making finely.
 *
 * ── The limitation, stated here rather than in a footnote ────────────────────────────
 *
 * The recovery scorer this uses was trained on **payment failures**, not on abandoned
 * checkouts. Its features are things like `is_soft_decline`, `bank_recent_fail_rate` and
 * `retry_count_so_far`, which describe a declined charge; an abandoned checkout has no
 * decline and no retries. So `P(recover | state, action)` here is a **borrowed estimate
 * on a different distribution, and it is not calibrated for this one.**
 *
 * That is a real caveat and it is not hidden: `docs/adr/0012` records it, and nothing in
 * this project reports a calibration or off-policy number for checkout abandonment,
 * because there is no held-out abandonment data to compute one against. What this
 * scenario demonstrates is that the *decision machinery* — the EV arithmetic, the risk
 * gate, the stopping rule, the audit trail, the escalation queue — generalises to a third
 * input shape without modification. It does not demonstrate that the probability is right,
 * and claiming otherwise would be exactly the kind of unearned number this project has
 * spent its evaluation removing.
 */
import { SUBSCRIPTION_SCENARIO, SUBSCRIPTION_DEFAULT_POLICY, type SubscriptionFeature } from './subscription'
import type { Policy, ScenarioDefinition } from './types'

export const CHECKOUT_ACTIONS = [
  'PAYMENT_LINK',
  'ESCALATE_HUMAN',
  'DO_NOTHING',
] as const
export type CheckoutAction = (typeof CHECKOUT_ACTIONS)[number]

/**
 * Costs and thresholds are inherited from the subscription policy rather than re-invented,
 * so a nudge costs the same paise and a human costs the same ₹40 wherever it happens —
 * two different prices for one agent's minute would make the two scenarios' EV numbers
 * incomparable for no reason.
 *
 * `maxRetries` counts CHASES, not charge attempts — how many times this cart has been
 * nudged before the system gives up on it. Three, matching the subscription scenario,
 * because "stop bothering someone after three attempts" is the same discipline whether
 * what failed was a charge or a checkout.
 *
 * It was briefly set to 0 here, on the reasoning that a menu with no retry action has no
 * retries to exhaust. That was wrong in a way a test caught immediately: the stopping rule
 * is `retryCount >= maxRetries`, so `0 >= 0` fires it on the very first event, and every
 * abandoned checkout — including a ₹1 one — was forced to `ESCALATE_HUMAN` at ₹40. A
 * limit meant to prevent over-contacting instead mandated the most expensive action
 * available, on every single event.
 */
export const CHECKOUT_DEFAULT_POLICY: Policy<CheckoutAction> = {
  ...SUBSCRIPTION_DEFAULT_POLICY,
  maxRetries: 3,
  contactFatigueActions: ['PAYMENT_LINK'],
  // No RETRY_NOW to suppress; a correlated failure burst says nothing about whether
  // someone abandoned a cart, so nothing here is shock-suppressed.
  shockSuppressedActions: [],
  escalationDailyBudget: null,
}

export const CHECKOUT_SCENARIO: ScenarioDefinition<CheckoutAction, SubscriptionFeature> = {
  ...SUBSCRIPTION_SCENARIO,
  id: 'checkout_abandonment',
  actions: CHECKOUT_ACTIONS,
  // Restated rather than inherited: the spread carries the subscription scenario's wider
  // action type, and both of these must be provably members of the narrower menu above.
  // `decide()` throws if `nullAction` is not in `actions`, so this is the compiler
  // catching at build time what would otherwise be a runtime failure on the first event.
  nullAction: 'DO_NOTHING',
  escalationAction: 'ESCALATE_HUMAN',
  defaultPolicy: CHECKOUT_DEFAULT_POLICY,
}
