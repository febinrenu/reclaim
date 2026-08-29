import Link from 'next/link'
import { CAPACITY_DATA } from './capacity-data'
import { CapacityCurve } from './capacity-chart'

export const dynamic = 'force-static'

/*
 * The escalation-capacity page: README's own admission that the unconstrained
 * policy escalates 91.6% of the demo split — a volume no real ops team can
 * staff — answered with the sweep it invites (scripts/data/escalation_budget_sweep.py,
 * `npm run escalation:sweep`). Static, like /model: this reads a committed
 * build artifact, not a live query.
 */
export default function CapacityPage(): React.JSX.Element {
  const data = CAPACITY_DATA
  const unconstrainedBudget = data.n_events_wanting_escalation_unconstrained
  const best = data.sweep.reduce((a, b) => (b.net_recovery_inr_per_txn > a.net_recovery_inr_per_txn ? b : a))
  const shownPoints = data.sweep

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
            <Link href="/operator" className="hover:text-accent">
              Operator
            </Link>
            <Link href="/simulate" className="hover:text-accent">
              Simulate
            </Link>
            <Link href="/scenarios" className="hover:text-accent">
              Scenarios
            </Link>
            <span className="text-accent">Capacity</span>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">What to do when you cannot staff every escalation</span>
          <h1 className="display mt-7 max-w-[30ch] text-section">
            The unconstrained policy escalates{' '}
            <span className="text-on-ink-dim">{(data.unconstrained_escalation_share * 100).toFixed(1)}%</span> of
            events. No ops team staffs that.
          </h1>
          <p className="mt-6 max-w-[68ch] text-body text-on-ink-soft">
            {data.n_events_wanting_escalation_unconstrained} of {data.n_events} demo events are ones
            `decide()` would escalate with no cap in force. This page answers the question that
            admission raises: given a daily cap on human escalations, which events should get one,
            and what does net recovery look like as the cap grows from zero to unbounded?
          </p>
          <p className="mt-4 max-w-[68ch] text-body text-on-ink-soft">
            Ranking is by the scorer&apos;s own estimated EV uplift of escalating over each event&apos;s
            best non-escalation action — never by the outcome, which a real system does not have yet
            when it has to decide. The outcome (oracle-truth) is only used afterward, to score the
            resulting allocation — the same decide-with-the-model, evaluate-with-the-truth split as
            every other number in this project.
          </p>

          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
            <div className="bg-ink-raised border border-ink-line p-6">
              <p className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">Never escalate</p>
              <p className="display mt-2 text-sub">₹{data.zero_budget_net_recovery_inr_per_txn.toFixed(2)}</p>
              <p className="mt-1 text-small text-on-ink-muted">net recovery, ₹/txn</p>
            </div>
            <div className="bg-ink-raised border border-accent p-6">
              <p className="text-[0.625rem] tracking-[0.11em] text-accent uppercase">
                Peak — budget {best.budget}
              </p>
              <p className="display mt-2 text-sub text-accent">₹{best.net_recovery_inr_per_txn.toFixed(2)}</p>
              <p className="mt-1 text-small text-on-ink-muted">
                {(best.escalated_share_of_split * 100).toFixed(1)}% of the split escalated
              </p>
            </div>
            <div className="bg-ink-raised border border-ink-line p-6">
              <p className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                Unconstrained (README&apos;s number)
              </p>
              <p className="display mt-2 text-sub">₹{data.unconstrained_net_recovery_inr_per_txn.toFixed(2)}</p>
              <p className="mt-1 text-small text-on-ink-muted">{unconstrainedBudget} escalations</p>
            </div>
          </div>

          <p className="mt-10 max-w-[68ch] text-body text-on-ink-soft">
            <strong className="text-on-ink">
              A capped budget of {best.budget} ({(best.escalated_share_of_split * 100).toFixed(1)}% of the
              split) reaches ₹{best.net_recovery_inr_per_txn.toFixed(2)}/txn — higher than escalating
              everyone.
            </strong>{' '}
            This is a real finding, not a rounding artefact: the lowest-ranked quarter or so of the
            unconstrained policy&apos;s own escalation choices are ones the model was confident about
            and the outcome disagreed with — the same model-misspecification gap the Bayes-optimal
            ceiling on the <Link href="/model" className="text-accent hover:opacity-80">model page</Link>{' '}
            already names. A capacity constraint happens to act as a coarse correction for it, on top
            of being the operational necessity it started as.
          </p>

          {data.knee_thresholds.budget_for_90pct_of_gap !== null && (
            <p className="mt-4 max-w-[68ch] text-body text-on-ink-soft">
              A budget of <strong className="text-on-ink">{data.knee_thresholds.budget_for_90pct_of_gap}</strong>{' '}
              already closes 90% of the gap between never escalating and escalating everyone;{' '}
              <strong className="text-on-ink">{data.knee_thresholds.budget_for_95pct_of_gap}</strong> closes
              95%. A merchant does not need to staff for the unconstrained number to capture nearly all
              of its value.
            </p>
          )}
        </div>
      </section>

      <section className="bg-paper px-gutter py-band">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-accent">The curve</span>
          <h2 className="display mt-7 max-w-[30ch] text-section text-on-paper">
            Net recovery <span className="text-on-paper-dim">as the budget grows</span>
          </h2>

          <div className="mt-10 bg-card p-6">
            <CapacityCurve points={shownPoints} bestBudget={best.budget} unconstrainedBudget={unconstrainedBudget} />
          </div>

          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[640px] border-t border-paper-line text-small">
              <caption className="sr-only">
                Net recovery per transaction at each swept daily escalation budget
              </caption>
              <thead>
                <tr className="border-b border-paper-line text-[0.625rem] tracking-[0.11em] text-on-paper-muted uppercase">
                  <th scope="col" className="py-2 text-left font-normal">
                    Budget
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Share escalated
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Net recovery (₹/txn)
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    % of gap closed
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownPoints
                  .filter(
                    (p, i) =>
                      p.budget <= 10 ||
                      i % 4 === 0 ||
                      p.budget === best.budget ||
                      p.budget === unconstrainedBudget,
                  )
                  .map((p) => (
                    <tr
                      key={p.budget}
                      className={`border-b border-paper-line ${p.budget === best.budget ? 'bg-accent/10' : ''}`}
                    >
                      <th scope="row" className="py-2 text-left font-normal text-on-paper">
                        {p.budget}
                      </th>
                      <td className="py-2 text-right tnum">{(p.escalated_share_of_split * 100).toFixed(1)}%</td>
                      <td className="py-2 text-right tnum">₹{p.net_recovery_inr_per_txn.toFixed(2)}</td>
                      <td className="py-2 text-right tnum">
                        {p.pct_of_unconstrained_gap_closed === null
                          ? 'n/a'
                          : `${(p.pct_of_unconstrained_gap_closed * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <p className="mt-6 max-w-[68ch] text-small text-on-paper-muted">
            Generated by <code>npm run escalation:sweep</code> into{' '}
            <code>docs/escalation_budget_results.json</code>, and reproduced in{' '}
            <code>docs/RESULTS.md</code> — the same numbers, never hand-typed twice.
          </p>
        </div>
      </section>
    </main>
  )
}
