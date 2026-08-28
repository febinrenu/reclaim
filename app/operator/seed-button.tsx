'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Puts a real work item on the queue without a terminal.
 *
 * `/operator` is empty on a fresh instance, and that is correct — a cost-aware policy
 * escalates rarely by design. But an empty queue is also indistinguishable from a broken
 * one, and the only way to populate it used to be `npm run escalate:demo`, which is no use
 * to anyone looking at a deployed URL.
 *
 * This is deliberately NOT a seeder. It posts a genuinely large abandoned checkout to the
 * real `/api/checkout/abandoned` route, and the EV arithmetic escalates it because a ₹40
 * human is trivial against that amount — the same decision the engine would reach on its
 * own. Nothing is inserted directly, no escalation is fabricated, and the resulting work
 * item is identical in every respect to one produced by a live event. If the policy ever
 * stopped escalating that amount, this button would stop producing work items, which is
 * the correct behaviour rather than a bug to work around.
 */
export function SeedEscalationButton(): React.JSX.Element {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setNote(null)
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 10_000)}`
    try {
      const res = await fetch('/api/checkout/abandoned', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: `evt_seed_${stamp}`,
          orderId: `order_seed_${stamp}`,
          customerId: `cust_seed_${stamp}`,
          // Large on purpose: at this value escalation genuinely wins on expected value.
          amountPaise: 500_000_00,
          minutesSinceCreated: 120,
          orderStatus: 'created',
        }),
      })
      const body = (await res.json()) as { chosenAction?: string; escalationId?: string | null }
      if (!res.ok) {
        setNote(`request failed (${res.status})`)
      } else if (body.escalationId != null) {
        setNote(null)
      } else {
        // Honest about the case where the policy declined to escalate.
        setNote(`the engine chose ${body.chosenAction ?? 'something else'} — no work item created`)
      }
      startTransition(() => router.refresh())
    } catch {
      setNote('could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || pending
  return (
    <div className="mt-8">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void run()}
        className="border border-ink-line px-4 py-2 text-[0.6875rem] tracking-[0.11em] text-on-ink-muted uppercase hover:text-accent disabled:opacity-50"
      >
        {disabled ? 'Running…' : 'Run a high-value abandoned checkout'}
      </button>
      <p className="mt-3 max-w-[70ch] text-small text-on-ink-muted">
        Posts a ₹5,00,000 abandoned cart to the real <code>/api/checkout/abandoned</code> route.
        Nothing is seeded or faked — at that amount the EV arithmetic escalates on its own, because
        a ₹40 human is trivial against it, and the work item that appears is identical to one from a
        live event.
      </p>
      {note !== null && (
        <p className="mt-2 text-small" style={{ color: 'var(--color-neg-bright)' }} role="status">
          {note}
        </p>
      )}
    </div>
  )
}
