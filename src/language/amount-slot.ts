/**
 * The single most valuable language guardrail in a fintech demo (BUILD_PLAN.md
 * §6.10): falling back when a drafted message states a rupee figure that does
 * not match the transaction. This project takes the stronger position available
 * to it rather than just detecting the mismatch after the fact — the exact
 * amount is never sent to the model at all. `redact-facts.ts` gives the model
 * only a *band* ("₹1,000-5,000"), and the prompt instructs it to write the
 * literal placeholder `{{amount}}` wherever the real figure belongs. That
 * placeholder is filled with the true amount for exactly the customer this
 * message is about, at use time — the same mechanism whether the text came from
 * the model, the cache, or a hand-written template, which is also what keeps a
 * cache entry safe to reuse across different customers' amounts within the same
 * band (BUILD_PLAN.md §5.8 point 2): nothing customer-specific is ever baked
 * into the cached string.
 *
 * The guardrail below is defense in depth for the case a model states a figure
 * anyway, ignoring the instruction — hallucinated, remembered from training data,
 * or copied from somewhere in the prompt it should not have used verbatim.
 */
export const AMOUNT_PLACEHOLDER = '{{amount}}'

const RUPEE_FIGURE_PATTERN = /₹\s?[\d,]+(?:\.\d+)?|\brs\.?\s?[\d,]+(?:\.\d+)?|\b[\d,]+(?:\.\d+)?\s?rupees\b/i

/** True if the message states a rupee-shaped figure anywhere outside the
 * placeholder — i.e. a number the model invented rather than the one this
 * transaction will actually be filled in with. */
export function hasStrayAmount(message: string): boolean {
  const withoutPlaceholders = message.split(AMOUNT_PLACEHOLDER).join('')
  return RUPEE_FIGURE_PATTERN.test(withoutPlaceholders)
}

const INR_FORMATTER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

export function formatRupeesForCopy(amountPaise: number): string {
  return `₹${INR_FORMATTER.format(Math.round(amountPaise / 100))}`
}

export function fillAmountSlot(message: string, amountPaise: number): string {
  return message.split(AMOUNT_PLACEHOLDER).join(formatRupeesForCopy(amountPaise))
}

export const LINK_PLACEHOLDER = '{{link}}'

/** The amount slot is the one with a hallucination guardrail (above) — a wrong
 * or missing link is a broken demo, not a fraud-adjacent risk, so it gets a
 * plain fill rather than a validator of its own. */
export function fillLinkSlot(message: string, url: string): string {
  return message.split(LINK_PLACEHOLDER).join(url)
}

export function fillSlots(message: string, values: { readonly amountPaise: number; readonly link?: string }): string {
  let filled = fillAmountSlot(message, values.amountPaise)
  if (values.link !== undefined) filled = fillLinkSlot(filled, values.link)
  return filled
}
