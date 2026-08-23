/**
 * Hand-written fallback copy (BUILD_PLAN.md §5.8 point 6): "not a stub... copy
 * that is genuinely fine to read aloud on camera." Eight variants each for the
 * two contact-requiring actions (WHATSAPP_NUDGE, PAYMENT_LINK) — the only
 * actions the subscription scenario ever drafts customer-facing copy for; the
 * other four actions are either silent or route to a human, never to a
 * customer-facing message (`SUBSCRIPTION_SCENARIO.requiresContact`).
 *
 * `{{amount}}` is filled in after selection — see amount-slot.ts — never baked
 * in here, so the same variant is safe to reuse across every customer whose
 * transaction happens to pick it.
 */
export const WHATSAPP_NUDGE_EN: readonly string[] = [
  "Hi! We noticed your recent payment of {{amount}} didn't go through. No stress — you can retry any time from your account, or reply here if you'd like a hand.",
  "Quick heads-up: your payment of {{amount}} didn't complete. It happens! Retry whenever suits you, or let us know if something's not working on our end.",
  "Just checking in — a payment of {{amount}} on your account didn't go through. Want to give it another try, or is there something we can help sort out?",
  "Hey there, your payment of {{amount}} was declined by your bank. Totally fine to retry with the same or a different method whenever you're ready.",
  "We tried to process {{amount}} and it didn't go through this time. Nothing to worry about — you can retry directly, and we're here if you need support.",
  "Heads up: {{amount}} didn't get charged successfully. Could be a card limit or a temporary hiccup — feel free to retry or reach out if it keeps happening.",
  "Your recent payment of {{amount}} wasn't successful. You're welcome to try again at your convenience, or message us if you'd like us to look into it.",
  "One quick note: a charge of {{amount}} didn't complete. Retrying usually does the trick — and we're always happy to help if it doesn't.",
]

export const PAYMENT_LINK_EN: readonly string[] = [
  "Hi! Your payment of {{amount}} didn't go through, so we've put together a secure link to make it easy to complete: {{link}}",
  "No worries about the missed payment of {{amount}} — here's a quick link to finish it up whenever you're ready: {{link}}",
  "We've set up a payment link for the {{amount}} that didn't go through, so you can complete it in a couple of taps: {{link}}",
  "Just in case retrying directly is tricky, here's a secure link for the {{amount}} payment: {{link}}",
  "Your payment of {{amount}} needs another attempt — this link makes it quick: {{link}}",
  "To save you the hassle, here's a direct link to settle the {{amount}} payment that didn't complete: {{link}}",
  "We noticed {{amount}} didn't process — use this secure link whenever it's convenient to complete it: {{link}}",
  "Here's an easy way to finish the {{amount}} payment that didn't go through the first time: {{link}}",
]
