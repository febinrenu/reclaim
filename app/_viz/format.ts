/**
 * Money/label formatting shared across every page that renders audit or batch
 * data. Previously copy-pasted with small, real inconsistencies: `batch-runner.tsx`'s
 * `formatMilliInr` did not sign-prefix a negative value the way `simulator.tsx`'s and
 * `ev-explorer.tsx`'s versions did (`₹-1.20` vs `-₹1.20`) — this file standardizes on
 * the sign-prefixed form everywhere, and on a single cached `Intl.NumberFormat`
 * rather than `simulator.tsx`'s per-call `toLocaleString`.
 */

const rupeeFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A `Paise` (or plain integer-paise) amount, formatted as INR. */
export function formatPaise(p: number): string {
  const sign = p < 0 ? '-' : ''
  return `${sign}₹${rupeeFmt.format(Math.abs(p) / 100)}`
}

/** A `MilliPaise` (or plain integer-milli-paise) amount, formatted as INR. EV
 * figures and cost components are stored in milli-paise for sub-paise precision
 * (BUILD_PLAN.md §5.1), so this divides by 100,000, not 100. */
export function formatMilliInr(m: number): string {
  const sign = m < 0 ? '-' : ''
  return `${sign}₹${rupeeFmt.format(Math.abs(m) / 100_000)}`
}

/** A signed amount, already formatted by `fmt`, with an explicit leading `+` for
 * positive values (`fmt` already handles the `-` sign for negative ones). */
export function formatSigned(v: number, fmt: (n: number) => string): string {
  return v > 0 ? `+${fmt(v)}` : fmt(v)
}

/** A glyph that carries the sign of a delta independent of color, so a change is
 * never communicated by color alone (BUILD_PLAN.md §3.5). */
export function deltaGlyph(v: number): '▲' | '▼' | '=' {
  return v > 0 ? '▲' : v < 0 ? '▼' : '='
}

export const ACTION_LABELS: Record<string, string> = {
  RETRY_NOW: 'Retry now',
  RETRY_LATER: 'Retry later',
  PAYMENT_LINK: 'Payment link',
  WHATSAPP_NUDGE: 'WhatsApp nudge',
  ESCALATE_HUMAN: 'Escalate to human',
  DO_NOTHING: 'Do nothing',
}

export const ACTION_ORDER: readonly string[] = [
  'RETRY_NOW',
  'RETRY_LATER',
  'PAYMENT_LINK',
  'WHATSAPP_NUDGE',
  'ESCALATE_HUMAN',
  'DO_NOTHING',
]
