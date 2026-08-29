'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ESCALATION_RESOLUTIONS, type EscalationResolution } from '@/domain/escalation'
import { formatPaise } from '~/_viz/format'

/**
 * One row of the escalation queue, with the three transitions an operator can make.
 *
 * A 409 back is not an error to apologise for — it means another operator got there
 * first, which is the ordinary case for a shared work queue. It is shown as a plain
 * sentence and the page refreshes so the row's real state appears, rather than leaving a
 * stale button the operator can keep pressing.
 */

export interface WorkItem {
  readonly id: string
  readonly eventId: string
  readonly transactionId: string | null
  readonly customerId: string | null
  readonly amountPaise: number
  readonly reason: 'risk_gated' | 'stopping_rule' | 'economic'
  readonly riskScore: number | null
  readonly rationale: string | null
  readonly status: 'open' | 'claimed' | 'resolved'
  readonly assignee: string | null
  readonly slaDueAtMs: number
  readonly overdue: boolean
  readonly resolution: EscalationResolution | null
}

const REASON_LABEL: Readonly<Record<WorkItem['reason'], string>> = {
  risk_gated: 'Risk gate fired',
  stopping_rule: 'Retries exhausted',
  economic: 'Escalation won on EV',
}

const RESOLUTION_LABEL: Readonly<Record<EscalationResolution, string>> = {
  paid: 'Paid',
  promised_to_pay: 'Promised to pay',
  disputed: 'Disputed',
  uncontactable: 'Uncontactable',
  written_off: 'Written off',
}

function relativeDeadline(slaDueAtMs: number, nowMs: number): string {
  const minutes = Math.round((slaDueAtMs - nowMs) / 60_000)
  const abs = Math.abs(minutes)
  const unit = abs >= 120 ? `${Math.round(abs / 60)}h` : `${abs}m`
  return minutes < 0 ? `${unit} overdue` : `${unit} left`
}

export function WorkItemRow({ item, nowMs }: { item: WorkItem; nowMs: number }): React.JSX.Element {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [assignee, setAssignee] = useState('')
  const [resolution, setResolution] = useState<EscalationResolution>('paid')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/escalations/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null
        setError(detail?.error ?? `request failed (${res.status})`)
      }
      // Refresh either way: on 409 the row's real state is what the operator needs to
      // see, and on success the server component re-reads it.
      startTransition(() => router.refresh())
    } catch {
      setError('could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || pending

  return (
    <div className="border-b border-ink-line py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="display text-[1.5rem] tnum leading-none">{formatPaise(item.amountPaise)}</span>
          <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
            {REASON_LABEL[item.reason]}
          </span>
          {item.riskScore !== null && (
            <span className="text-small text-on-ink-muted tnum">risk {item.riskScore.toFixed(2)}</span>
          )}
        </div>
        <span
          className="text-[0.625rem] tracking-[0.11em] uppercase tnum"
          style={{ color: item.overdue ? 'var(--color-neg-bright)' : 'var(--color-on-ink-muted)' }}
        >
          {item.overdue ? '● ' : ''}
          {relativeDeadline(item.slaDueAtMs, nowMs)}
        </span>
      </div>

      <p className="mt-3 max-w-[80ch] text-small text-on-ink-soft">{item.rationale ?? 'No rationale recorded.'}</p>

      <p className="mt-2 font-mono text-[0.6875rem] text-on-ink-faint">
        {item.eventId}
        {item.customerId !== null ? ` · ${item.customerId}` : ''}
        {item.transactionId !== null && (
          <>
            {' · '}
            <Link href={`/audit/timeline/${encodeURIComponent(item.transactionId)}`} className="text-accent hover:opacity-80">
              full timeline
            </Link>
          </>
        )}
      </p>

      {item.status === 'open' && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="sr-only" htmlFor={`assignee-${item.id}`}>
            Your name
          </label>
          <input
            id={`assignee-${item.id}`}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="your name (optional)"
            maxLength={120}
            className="border border-ink-line bg-ink-raised px-3 py-2 text-small text-on-ink placeholder:text-on-ink-faint"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => void send({ op: 'claim', assignee })}
            className="bg-accent px-4 py-2 text-[0.6875rem] tracking-[0.11em] text-ink uppercase disabled:opacity-50"
          >
            {disabled ? 'Claiming…' : 'Claim'}
          </button>
        </div>
      )}

      {item.status === 'claimed' && (
        <div className="mt-4">
          <p className="text-small text-on-ink-muted">
            Claimed by <span className="text-on-ink-soft">{item.assignee ?? 'unattributed'}</span>
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor={`resolution-${item.id}`}
                className="block text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase"
              >
                Outcome
              </label>
              <select
                id={`resolution-${item.id}`}
                value={resolution}
                onChange={(e) => setResolution(e.target.value as EscalationResolution)}
                className="mt-1 border border-ink-line bg-ink-raised px-3 py-2 text-small text-on-ink"
              >
                {ESCALATION_RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {RESOLUTION_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[16rem] flex-1">
              <label
                htmlFor={`note-${item.id}`}
                className="block text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase"
              >
                Note
              </label>
              <input
                id={`note-${item.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="what happened"
                maxLength={2000}
                className="mt-1 w-full border border-ink-line bg-ink-raised px-3 py-2 text-small text-on-ink placeholder:text-on-ink-faint"
              />
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void send({ op: 'resolve', resolution, note })}
              className="bg-accent px-4 py-2 text-[0.6875rem] tracking-[0.11em] text-ink uppercase disabled:opacity-50"
            >
              {disabled ? 'Saving…' : 'Resolve'}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void send({ op: 'release' })}
              className="border border-ink-line px-4 py-2 text-[0.6875rem] tracking-[0.11em] text-on-ink-muted uppercase disabled:opacity-50 hover:text-accent"
            >
              Release
            </button>
          </div>
          {resolution === 'promised_to_pay' && (
            <p className="mt-3 max-w-[70ch] text-small text-on-ink-muted">
              A promise is not a payment: this records the conversation and leaves the transaction
              open. If the promise is kept, a real <code>payment.captured</code> webhook settles it
              through the normal path and is counted once, there.
            </p>
          )}
        </div>
      )}

      {error !== null && (
        <p className="mt-3 text-small" style={{ color: 'var(--color-neg-bright)' }} role="status">
          {error}
        </p>
      )}
    </div>
  )
}
