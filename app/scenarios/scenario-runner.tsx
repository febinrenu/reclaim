'use client'

import { useState } from 'react'
import Link from 'next/link'
import { formatMilliInr } from '~/_viz/format'

/**
 * Runs one event through a scenario's real pipeline and shows what `decide()` chose.
 *
 * These two scenarios were API-only until now: reachable with `curl`, invisible in the
 * product. That made the architecture's central claim — three inputs, one engine —
 * something a reviewer had to take on trust or verify from a terminal. Everything here
 * posts to the same route an integration would, gets the same response, and writes the
 * same `recovery_audit` row the subscription path does; there is no demo-only shortcut
 * behind it.
 */

interface DecisionResponse {
  readonly duplicate?: boolean
  readonly chosenAction?: string
  readonly pRecover?: number | null
  readonly evMilli?: number | null
  readonly upliftMilli?: number | null
  readonly riskGated?: boolean
  readonly escalationId?: string | null
  readonly rationale?: string | null
  readonly draftedMessage?: string | null
  readonly error?: string
}

const ACTION_BLURB: Readonly<Record<string, string>> = {
  PAYMENT_LINK: 'a fresh customer-facing checkout — the one action with a real gateway call',
  WHATSAPP_NUDGE: 'a drafted message; delivery is opt-in to a consented address',
  ESCALATE_HUMAN: 'a real work item, with an owner and a deadline, on the operator queue',
  DO_NOTHING: 'the organic baseline won — acting would have cost more than it returned',
  SEND_REMINDER: 'a drafted reminder for an overdue invoice',
  OFFER_PAYMENT_PLAN: 'a structured instalment offer',
  ESCALATE_COLLECTIONS: 'handed to collections',
  WRITE_OFF: 'the null action for receivables — stop spending on this debt',
  PAID: 'already settled, so there was nothing to decide',
}

function Field({
  scope,
  label,
  value,
  onChange,
  suffix,
  min = 1,
}: {
  /** Both runners are on one page and both have an "Amount" field, so the id has to be
   * scoped or the two labels point at the same input — which is exactly what happened. */
  scope: string
  label: string
  value: number
  onChange: (n: number) => void
  suffix: string
  min?: number
}): React.JSX.Element {
  const id = `f-${scope}-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <div>
      <label htmlFor={id} className="block text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
        {label}
      </label>
      <div className="mt-1 flex items-baseline gap-2">
        <input
          id={id}
          type="number"
          min={min}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-36 border border-ink-line bg-ink-raised px-3 py-2 text-small text-on-ink tnum"
        />
        <span className="text-small text-on-ink-faint">{suffix}</span>
      </div>
    </div>
  )
}

function Result({ data }: { data: DecisionResponse }): React.JSX.Element {
  if (data.error !== undefined) {
    return (
      <p className="mt-5 text-small" style={{ color: 'var(--color-neg-bright)' }} role="status">
        {data.error}
      </p>
    )
  }
  const action = data.chosenAction ?? '—'
  return (
    <div className="mt-6 border-t border-ink-line pt-5" role="status">
      <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
        decide() chose
      </span>
      <p className="display mt-2 text-[1.5rem] leading-none text-accent">{action}</p>
      <p className="mt-2 max-w-[54ch] text-small text-on-ink-muted">{ACTION_BLURB[action] ?? ''}</p>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-small sm:grid-cols-4">
        {data.pRecover !== null && data.pRecover !== undefined && (
          <div>
            <dt className="text-[0.625rem] tracking-[0.11em] text-on-ink-faint uppercase">P(recover)</dt>
            <dd className="tnum text-on-ink-soft">{(data.pRecover * 100).toFixed(2)}%</dd>
          </div>
        )}
        {data.evMilli !== null && data.evMilli !== undefined && (
          <div>
            <dt className="text-[0.625rem] tracking-[0.11em] text-on-ink-faint uppercase">EV</dt>
            <dd className="tnum text-on-ink-soft">{formatMilliInr(data.evMilli)}</dd>
          </div>
        )}
        {data.upliftMilli !== null && data.upliftMilli !== undefined && (
          <div>
            <dt className="text-[0.625rem] tracking-[0.11em] text-on-ink-faint uppercase">
              Uplift vs nothing
            </dt>
            <dd className="tnum text-on-ink-soft">{formatMilliInr(data.upliftMilli)}</dd>
          </div>
        )}
        <div>
          <dt className="text-[0.625rem] tracking-[0.11em] text-on-ink-faint uppercase">Risk gate</dt>
          <dd className="text-on-ink-soft">{data.riskGated === true ? 'fired' : 'clear'}</dd>
        </div>
      </dl>

      {data.rationale !== null && data.rationale !== undefined && (
        <p className="mt-4 max-w-[70ch] text-small text-on-ink-soft">{data.rationale}</p>
      )}
      {data.draftedMessage !== null && data.draftedMessage !== undefined && (
        <p className="mt-3 max-w-[70ch] border-l-2 border-accent-dim pl-3 text-small text-on-ink-muted italic">
          {data.draftedMessage}
        </p>
      )}

      <p className="mt-5 text-small text-on-ink-muted">
        {data.escalationId !== null && data.escalationId !== undefined ? (
          <>
            A work item was created —{' '}
            <Link href="/operator" className="text-accent hover:opacity-80">
              open the escalation queue →
            </Link>
          </>
        ) : (
          <>
            The decision is on the{' '}
            <Link href="/audit" className="text-accent hover:opacity-80">
              audit ledger
            </Link>
            , badged with the scenario that produced it.
          </>
        )}
      </p>
    </div>
  )
}

export function ScenarioRunner({
  kind,
}: {
  kind: 'b2b' | 'checkout'
}): React.JSX.Element {
  const isB2b = kind === 'b2b'
  const [rupees, setRupees] = useState(isB2b ? 45_000 : 3_200)
  const [secondary, setSecondary] = useState(isB2b ? 45 : 90)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DecisionResponse | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setResult(null)
    // A fresh id per run, so each press is a genuinely new event rather than a replay
    // the idempotency guard would (correctly) refuse to decide twice.
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 10_000)}`
    const url = isB2b ? '/api/b2b/invoices' : '/api/checkout/abandoned'
    const body = isB2b
      ? {
          eventId: `evt_ui_inv_${stamp}`,
          invoiceId: `inv_ui_${stamp}`,
          customerId: `cust_ui_inv_${stamp}`,
          amountPaise: Math.max(1, Math.round(rupees * 100)),
          daysOverdue: Math.max(0, Math.round(secondary)),
        }
      : {
          eventId: `evt_ui_cart_${stamp}`,
          orderId: `order_ui_${stamp}`,
          customerId: `cust_ui_cart_${stamp}`,
          amountPaise: Math.max(1, Math.round(rupees * 100)),
          minutesSinceCreated: Math.max(0, Math.round(secondary)),
          orderStatus: 'created' as const,
        }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as DecisionResponse
      setResult(
        res.ok
          ? json
          : { error: json.error ?? `request failed (${res.status})` },
      )
    } catch {
      setResult({ error: 'could not reach the server' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-ink-raised p-8">
      <span className="eyebrow text-accent">{isB2b ? 'B2B receivable' : 'Abandoned checkout'}</span>
      <h2 className="display mt-5 text-[1.75rem] leading-[1.1]">
        {isB2b ? 'An overdue invoice' : 'A cart nobody paid for'}
      </h2>
      <p className="mt-4 max-w-[60ch] text-small text-on-ink-muted">
        {isB2b
          ? 'Its own action vocabulary, its own independently trained scorer, its own cost table — and the same decide(), risk gate and audit trail.'
          : 'No charge was ever attempted, so there is nothing to retry: the menu drops both retry actions. The scorer is borrowed from the subscription scenario and is not calibrated for this one, which is why no accuracy number is claimed for it.'}
      </p>

      <div className="mt-7 flex flex-wrap items-end gap-5">
        <Field scope={kind} label="Amount" value={rupees} onChange={setRupees} suffix="₹" />
        <Field
          scope={kind}
          label={isB2b ? 'Days overdue' : 'Minutes unpaid'}
          value={secondary}
          onChange={setSecondary}
          suffix={isB2b ? 'days' : 'min'}
          min={0}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className="bg-accent px-5 py-2.5 text-[0.6875rem] tracking-[0.11em] text-ink uppercase disabled:opacity-50"
        >
          {busy ? 'Deciding…' : 'Run it'}
        </button>
      </div>

      {result !== null && <Result data={result} />}
    </div>
  )
}
