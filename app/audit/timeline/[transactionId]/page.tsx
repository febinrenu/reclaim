import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDeps } from '@/server/di'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import type { RecoveryAuditRow } from '@/repositories/recovery-audit.repo'
import * as escalationsRepo from '@/repositories/escalations.repo'
import type { EscalationRow } from '@/repositories/escalations.repo'
import { transactionId as toTransactionId } from '@/domain/ids'
import { parseEvBreakdown, parseAmountPaise } from '../../view-model'
import { EvExplorer } from '../../ev-explorer'
import { formatPaise, formatMilliInr, ACTION_LABELS } from '~/_viz/format'

export const dynamic = 'force-dynamic'

const SCENARIO_LABELS: Readonly<Record<string, string>> = {
  b2b_receivable: 'B2B invoice',
  checkout_abandonment: 'Abandoned cart',
}

const OUTCOME_GLYPH: Record<string, string> = {
  success: '✓',
  failed: '✕',
  pending: '…',
  skipped: '–',
  unknown: '?',
}

/**
 * The whole life of one transaction, not one decision — the multi-cycle story
 * `schedule-followup.ts` actually drives (immediate, then +2h, then +24h, each
 * a real re-run of `processEvent`) has been true since D11, but every other
 * screen in this app shows exactly one row from it at a time. This page reads
 * `recoveryAuditRepo.listByTransaction`, so every cycle a transaction went
 * through — retried, nudged, escalated, resolved — renders as one sequence
 * instead of requiring a reader to reconstruct it from `job_queue` timestamps.
 */
export default async function TransactionTimelinePage({
  params,
}: {
  params: Promise<{ transactionId: string }>
}): Promise<React.JSX.Element> {
  const { transactionId: rawId } = await params
  const deps = await getDeps()

  const [decisions, escalations] = await Promise.all([
    recoveryAuditRepo.listByTransaction(deps.sql, toTransactionId(rawId)),
    escalationsRepo.listByTransaction(deps.sql, toTransactionId(rawId)),
  ])

  if (decisions.length === 0) notFound()

  const scenario = decisions.find((d) => d.scenario !== null)?.scenario ?? null
  const amountPaise = parseAmountPaise(decisions[0]?.decisionInput ?? null)

  // Interleave decisions and escalation resolutions into one chronological
  // sequence — an escalation is a real state change (open -> claimed ->
  // resolved) this transaction went through, not an annotation on the
  // decision that created it.
  type Step =
    | { kind: 'decision'; at: Date; data: (typeof decisions)[number] }
    | { kind: 'escalation'; at: Date; data: (typeof escalations)[number] }
  const steps: Step[] = [
    ...decisions.map((d): Step => ({ kind: 'decision', at: d.createdAt, data: d })),
    ...escalations
      .filter((e) => e.resolvedAt !== null)
      .map((e): Step => ({ kind: 'escalation', at: e.resolvedAt as Date, data: e })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())

  return (
    <main id="main">
      <section className="bg-ink px-gutter pt-8 pb-band">
        <nav className="mx-auto flex max-w-[1240px] items-center justify-between">
          <Link href="/" className="display text-[1.0625rem] tracking-[0.06em] uppercase">
            Reclaim
          </Link>
          <Link href="/audit" className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase hover:text-accent">
            ← Back to audit
          </Link>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">One transaction, every cycle</span>
          <h1 className="display mt-7 max-w-[40ch] break-all text-sub">{rawId}</h1>
          <p className="mt-4 flex flex-wrap items-center gap-3 text-body text-on-ink-soft">
            {scenario !== null && scenario !== 'subscription' && (
              <span
                className="rounded-full border px-2 py-0.5 text-[0.5625rem] tracking-[0.08em] uppercase"
                style={{ borderColor: 'var(--color-accent-dim)', color: 'var(--color-accent)' }}
              >
                {SCENARIO_LABELS[scenario] ?? scenario}
              </span>
            )}
            {amountPaise !== null && <span>{formatPaise(amountPaise)}</span>}
            <span className="text-on-ink-muted">
              {decisions.length} decision{decisions.length === 1 ? '' : 's'}
              {escalations.length > 0 ? `, ${escalations.length} escalation${escalations.length === 1 ? '' : 's'}` : ''}
            </span>
          </p>
        </div>
      </section>

      <section className="bg-paper px-gutter py-band">
        <div className="mx-auto max-w-[1240px]">
          <ol className="relative space-y-10 border-l border-paper-line pl-8">
            {steps.map((step, i) => (
              <li key={`${step.kind}-${i}`} className="relative">
                <span
                  className="absolute -left-[calc(2rem+5px)] top-1.5 h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: step.kind === 'escalation' ? 'var(--color-accent)' : 'var(--color-on-paper-dim)' }}
                  aria-hidden="true"
                />
                {step.kind === 'decision' ? (
                  <DecisionStep row={step.data} index={i} />
                ) : (
                  <EscalationStep row={step.data} />
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  )
}

function DecisionStep({ row, index }: { row: RecoveryAuditRow; index: number }): React.JSX.Element {
  const breakdown = parseEvBreakdown(row.evBreakdown)
  return (
    <div className="bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-[0.625rem] tracking-[0.11em] text-on-paper-muted uppercase">
          Cycle {index + 1} — {row.createdAt.toLocaleString('en-IN', { hour12: false })}
        </p>
        <span
          className="rounded-full px-2 py-0.5 text-[0.625rem] tracking-[0.08em] uppercase"
          style={{
            backgroundColor: row.executionMode === 'live' ? 'var(--color-pos)' : 'var(--color-ink-line)',
            color: row.executionMode === 'live' ? 'var(--color-on-ink)' : 'var(--color-on-ink-soft)',
          }}
        >
          {row.executionMode === 'live' ? '● live' : '○ dry run'}
        </span>
      </div>
      <p className="mt-3 font-mono text-small text-on-paper-muted">{row.eventId}</p>
      <p className="display mt-3 text-sub text-on-paper">{ACTION_LABELS[row.chosenAction] ?? row.chosenAction}</p>
      <div className="mt-4 flex flex-wrap gap-6 text-small text-on-paper-muted">
        {row.evMilli !== null && <span>EV {formatMilliInr(row.evMilli)}</span>}
        {row.upliftMilli !== null && <span>Uplift {formatMilliInr(row.upliftMilli)}</span>}
        {row.riskScore !== null && <span>Risk score {row.riskScore.toFixed(2)}</span>}
        <span>
          <span aria-hidden="true">{row.outcome !== null ? (OUTCOME_GLYPH[row.outcome] ?? '?') : '—'}</span>{' '}
          {row.outcome ?? 'n/a'}
        </span>
      </div>
      {row.rationale !== null && <p className="mt-3 text-body text-on-paper-muted italic">&ldquo;{row.rationale}&rdquo;</p>}
      {breakdown !== null && (
        <div className="mt-6">
          <EvExplorer breakdown={breakdown} chosenAction={row.chosenAction} rationale={row.rationale} />
        </div>
      )}
    </div>
  )
}

function EscalationStep({ row }: { row: EscalationRow }): React.JSX.Element {
  return (
    <div className="border border-accent bg-card p-6">
      <p className="text-[0.625rem] tracking-[0.11em] text-accent uppercase">
        Escalation resolved — {row.resolvedAt !== null ? row.resolvedAt.toLocaleString('en-IN', { hour12: false }) : ''}
      </p>
      <p className="display mt-3 text-sub text-on-paper">
        {row.resolution ?? 'unresolved'}
      </p>
      <p className="mt-3 text-small text-on-paper-muted">
        Reason: {row.reason} · Assignee: {row.assignee ?? 'unclaimed'}
      </p>
      {row.resolutionNote !== null && <p className="mt-3 text-body text-on-paper-muted italic">&ldquo;{row.resolutionNote}&rdquo;</p>}
      {row.rationale !== null && <p className="mt-3 text-small text-on-paper-muted">{row.rationale}</p>}
      <p className="mt-3 text-small text-on-paper-muted">
        This is the one place in this project where an outcome comes from a person rather
        than the data generator.
      </p>
    </div>
  )
}
