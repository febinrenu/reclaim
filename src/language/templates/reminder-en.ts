/**
 * The B2B receivables chaser's customer-facing copy banks (SYSTEM_SPEC.md §16
 * — "reuse... the dashboard"). Eight variants each for the two contact-requiring
 * actions (`SEND_REMINDER`, `OFFER_PAYMENT_PLAN` —
 * `B2B_RECEIVABLE_SCENARIO.requiresContact`), matching `nudge-en.ts`'s exact
 * shape: `{{amount}}` filled in after selection (`amount-slot.ts`), never
 * baked in here.
 *
 * Committed and parity-checked against `template-engine.ts`'s own
 * `fillNamedSlots`/`pickVariant` machinery, but **not yet wired into
 * `selectNudgeTemplate`'s bank lookup** — that function's `NUDGE_BANKS` type
 * is keyed to the subscription action literals (`'WHATSAPP_NUDGE' |
 * 'PAYMENT_LINK'`), and widening it is a small, real change to shared
 * language-layer machinery outside the scenario/templates directories this
 * second scenario is scoped to for now (BUILD_PLAN.md's D12 exit test). Left
 * as an honest, explicit next step rather than forced in — the same choice
 * made for not wiring this scenario into the live worker at all.
 */
export const SEND_REMINDER_EN: readonly string[] = [
  "Hi! This is a friendly reminder that invoice {{amount}} is now overdue. Let us know if there's anything holding up payment, or feel free to settle it whenever convenient.",
  "Just a quick note that an invoice of {{amount}} has passed its due date. No rush on our end — happy to help if anything's blocking it.",
  "Following up on an outstanding invoice of {{amount}}. If it's already been paid, apologies for the reminder — otherwise, whenever works for you is fine.",
  "Checking in on invoice {{amount}}, which is now past due. Let us know if you'd like to discuss timing or if there's anything we can clarify.",
  "A heads-up that {{amount}} on your account is overdue. We're flexible on timing — just wanted to make sure this hadn't slipped through.",
  "This is a courtesy reminder for the overdue invoice of {{amount}}. Reach out any time if you need a copy of the invoice or have questions.",
  "Wanted to flag that an invoice of {{amount}} is past its due date. Whenever you get a chance to process it works for us.",
  "Just following up on {{amount}} that's now overdue — let us know if there's anything we can do to help move it along.",
]

export const OFFER_PAYMENT_PLAN_EN: readonly string[] = [
  "We noticed the {{amount}} invoice has been outstanding for a while — happy to set up a payment plan if that would help. Just let us know.",
  "If settling {{amount}} all at once is difficult right now, we're glad to work out a payment plan that fits better. Reach out whenever you'd like to discuss.",
  "For the outstanding {{amount}}, we can offer a split payment arrangement if that's easier on your end — just say the word.",
  "We'd rather find a workable path than let {{amount}} sit unpaid — a payment plan is on the table whenever you're ready to talk.",
  "Given the {{amount}} balance has been open for some time, would a structured payment plan help? Happy to set one up.",
  "No pressure to pay {{amount}} in one go — we can break it into a plan that's easier to manage if that helps.",
  "We're open to a payment plan for the {{amount}} outstanding, rather than letting it continue to age. Let us know what would work.",
  "To make the {{amount}} balance easier to clear, we can offer instalments — happy to set that up whenever suits you.",
]
