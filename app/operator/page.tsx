import Link from 'next/link'
import { getDeps } from '@/server/di'
import * as escalationsRepo from '@/repositories/escalations.repo'
import { isOverdue, ESCALATION_SLA_HOURS } from '@/domain/escalation'
import { formatPaise } from '~/_viz/format'
import { WorkItemRow, type WorkItem } from './work-item'

export const dynamic = 'force-dynamic'

/*
 * The escalation queue — where ESCALATE_HUMAN actually goes.
 *
 * This page is the answer to a real gap, not a feature added for completeness. `decide()`
 * could choose escalation, and the risk gate could force it, and then nothing happened:
 * src/ports/executor.ts has no side effect for that action, so a decision to involve a
 * human produced no work item, no assignee, no deadline, and no way to record what the
 * human found. Track 03's bar asks for "compliant escalation"; an escalation with no
 * recipient is not one.
 *
 * It also closes a gap in the *evaluation*. Every label this project reports against
 * comes from its own generator (docs/EVALUATION.md is explicit about that, and the
 * customer-disjoint validation exists because the limitation is real). A resolved
 * escalation is the first label here the DGP did not draw — a human looked at a specific
 * payment and reported what happened — and resolving one writes that outcome back through
 * `recordCustomerOutcome`, so `prior_success_rate` and `ltv_zscore` start being fed by
 * observed reality. See src/app/operator/resolve-escalation.ts.
 */

const RESOLUTION_LABEL: Readonly<Record<string, string>> = {
  paid: 'Paid',
  promised_to_pay: 'Promised to pay',
  disputed: 'Disputed',
  uncontactable: 'Uncontactable',
  written_off: 'Written off',
}

export default async function OperatorPage(): Promise<React.JSX.Element> {
  const deps = await getDeps()
  const nowMs = deps.clock.nowMs()

  const [queue, resolved, stats] = await Promise.all([
    escalationsRepo.listQueue(deps.sql, 100),
    escalationsRepo.listResolved(deps.sql, 25),
    escalationsRepo.queueStats(deps.sql, nowMs),
  ])

  const items: readonly WorkItem[] = queue.map((e) => ({
    id: e.id,
    eventId: e.eventId,
    transactionId: e.transactionId,
    customerId: e.customerId,
    amountPaise: e.amountPaise,
    reason: e.reason,
    riskScore: e.riskScore,
    rationale: e.rationale,
    status: e.status,
    assignee: e.assignee,
    slaDueAtMs: e.slaDueAt.getTime(),
    overdue: isOverdue(e.slaDueAt.getTime(), nowMs),
    resolution: e.resolution,
  }))

  const openValue = queue.reduce((sum, e) => sum + e.amountPaise, 0)

  return (
    <main id="main">
      <section className="bg-ink px-gutter pt-8 pb-band">
        <nav className="mx-auto flex max-w-[1240px] items-center justify-between">
          <Link href="/" className="display text-[1.0625rem] tracking-[0.06em] uppercase">
            Reclaim
          </Link>
          <div className="flex gap-6 text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
            <Link href="/dashboard" className="hover:text-accent">
              Dashboard
            </Link>
            <Link href="/audit" className="hover:text-accent">
              Audit
            </Link>
            <Link href="/model" className="hover:text-accent">
              Model
            </Link>
            <Link href="/queue" className="hover:text-accent">
              Queue
            </Link>
            <span className="text-accent">Operator</span>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">Escalation queue</span>
          <h1 className="display mt-7 max-w-[24ch] text-section">
            Where escalation <span className="text-on-ink-dim">actually goes</span>
          </h1>
          <p className="mt-6 max-w-[72ch] text-body text-on-ink-soft">
            When the risk gate fires, or retries run out, or escalation simply wins on expected
            value, the decision lands here as a work item with an owner and a deadline. Resolving
            one writes the outcome back to the customer&apos;s real history — which makes these the
            only labels in this project that its own data generator did not draw.
          </p>

          <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Tile label="Open" value={String(stats.open)} note={formatPaise(openValue) + ' unresolved'} />
            <Tile label="Claimed" value={String(stats.claimed)} note="being worked" />
            <Tile
              label="Overdue"
              value={String(stats.overdue)}
              note="past SLA"
              emphasis={stats.overdue > 0}
            />
            <Tile label="Resolved" value={String(stats.resolved)} note="human-observed outcomes" />
          </div>

          <p className="mt-6 text-small text-on-ink-muted">
            Response deadlines by reason: risk gate {ESCALATION_SLA_HOURS.risk_gated}h, retries
            exhausted {ESCALATION_SLA_HOURS.stopping_rule}h, economic{' '}
            {ESCALATION_SLA_HOURS.economic}h. These are a stated policy, not a measurement — there
            is no real operations team here whose response times could be observed, and a number
            that looked derived would be worse than one that is plainly a choice.
          </p>

          <div className="mt-14">
            <span className="eyebrow text-on-ink-muted">The queue</span>
            {items.length === 0 ? (
              <div className="mt-6 border-t border-ink-line py-16 text-center">
                <p className="text-body text-on-ink-soft">Nothing is waiting on a human.</p>
                <p className="mt-3 max-w-[60ch] mx-auto text-small text-on-ink-muted">
                  Escalations appear here when <code>decide()</code> chooses{' '}
                  <code>ESCALATE_HUMAN</code>. A cost-aware policy escalates rarely by design — a
                  ₹40 human-agent cost only clears the bar on a large enough amount — so an empty
                  queue is the expected state, not a broken one. Run{' '}
                  <code>npm run burst</code> to force the risk gate to fire, or a batch from the{' '}
                  <Link href="/dashboard" className="text-accent hover:opacity-80">
                    dashboard
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <div className="mt-6 border-t border-ink-line">
                {items.map((item) => (
                  <WorkItemRow key={item.id} item={item} nowMs={nowMs} />
                ))}
              </div>
            )}
          </div>

          {resolved.length > 0 && (
            <div className="mt-14">
              <span className="eyebrow text-on-ink-muted">Recently resolved</span>
              <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[640px] border-t border-ink-line text-small">
                  <caption className="sr-only">Recently resolved escalations</caption>
                  <thead>
                    <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Resolved
                      </th>
                      <th scope="col" className="py-3 pr-4 text-right font-normal">
                        Amount
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Outcome
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        By
                      </th>
                      <th scope="col" className="py-3 text-left font-normal">
                        Note
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.map((e) => (
                      <tr key={e.id} className="border-b border-ink-line">
                        <td className="py-3 pr-4 text-on-ink-muted tnum">
                          {e.resolvedAt?.toLocaleString('en-IN', { hour12: false }) ?? '—'}
                        </td>
                        <td className="py-3 pr-4 text-right tnum">{formatPaise(e.amountPaise)}</td>
                        <td className="py-3 pr-4">
                          <span
                            style={{
                              color:
                                e.resolution === 'paid'
                                  ? 'var(--color-pos-bright)'
                                  : e.resolution === 'promised_to_pay'
                                    ? 'var(--color-on-ink-soft)'
                                    : 'var(--color-neg-bright)',
                            }}
                          >
                            {e.resolution !== null ? (RESOLUTION_LABEL[e.resolution] ?? e.resolution) : '—'}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-on-ink-muted">{e.assignee ?? '—'}</td>
                        <td className="max-w-[40ch] truncate py-3 text-on-ink-muted">
                          {e.resolutionNote ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {stats.byResolution.size > 0 && (
                <p className="mt-4 max-w-[72ch] text-small text-on-ink-muted">
                  Human-observed outcomes so far:{' '}
                  {[...stats.byResolution.entries()]
                    .map(([r, n]) => `${RESOLUTION_LABEL[r] ?? r} ${n}`)
                    .join(' · ')}
                  . Only <em>Paid</em> counts as recovery. A promise is not a payment, and counting
                  it as one is exactly the self-flattering accounting this project exists to avoid.
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function Tile({
  label,
  value,
  note,
  emphasis = false,
}: {
  label: string
  value: string
  note: string
  emphasis?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col justify-between border border-ink-line p-6">
      <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">{label}</span>
      <span
        className="display mt-6 text-[2.25rem] tnum leading-none"
        style={emphasis ? { color: 'var(--color-neg-bright)' } : undefined}
      >
        {value}
      </span>
      <span className="mt-2 text-[0.625rem] text-on-ink-faint">{note}</span>
    </div>
  )
}
