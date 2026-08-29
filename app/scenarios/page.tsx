import Link from 'next/link'
import { ScenarioRunner } from './scenario-runner'

export const dynamic = 'force-dynamic'

/*
 * The three-inputs-one-engine claim, made clickable.
 *
 * B2B receivables and checkout abandonment were both fully wired and completely invisible:
 * reachable only by POSTing to a route from a terminal. That left this project's central
 * architectural claim — that `decide()` is a general `(input, policy, scenario) ->
 * decision` rather than a payment-failure special case — as something a reviewer had to
 * take on trust, or verify with curl, which nobody does.
 *
 * Every button here posts to the same route a real integration would, and gets the same
 * response. There is no demo-only path behind them: each run writes a real `transactions`
 * row, a real `action_attempts` intent, and a real `recovery_audit` row, and an escalated
 * one creates a real work item on /operator.
 */
export default function ScenariosPage(): React.JSX.Element {
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
            <span className="text-accent">Scenarios</span>
            <Link href="/capacity" className="hover:text-accent">
              Capacity
            </Link>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">One engine, three inputs</span>
          <h1 className="display mt-7 max-w-[26ch] text-section">
            The same decision engine, <span className="text-on-ink-dim">on three different problems</span>
          </h1>
          <p className="mt-6 max-w-[74ch] text-body text-on-ink-soft">
            Track 03 names payment failures, checkout abandonment and overdue receivables. All three
            run through the same <code>decide()</code>, the same risk gate, the same stopping rule,
            the same audit trail and the same escalation queue. The later two were added as
            configuration — a different action vocabulary and cost table — with no existing code path
            changed to accommodate either.
          </p>
          <p className="mt-4 max-w-[74ch] text-small text-on-ink-muted">
            Failed payments are the first input, and they have their own screen: run a batch of
            signed <code>payment.failed</code> deliveries from the{' '}
            <Link href="/dashboard" className="text-accent hover:opacity-80">
              dashboard
            </Link>
            . The other two are below. Each press posts to the same API an integration would use and
            writes a real audit row — there is no demo-only path behind these buttons.
          </p>

          <div className="mt-12 grid gap-px bg-ink-line lg:grid-cols-2">
            <ScenarioRunner kind="b2b" />
            <ScenarioRunner kind="checkout" />
          </div>

          <div className="mt-12 max-w-[74ch] border-t border-ink-line pt-8">
            <span className="eyebrow text-on-ink-muted">What differs, and what does not</span>
            <table className="mt-6 w-full border-t border-ink-line text-small">
              <caption className="sr-only">What each scenario configures versus reuses</caption>
              <tbody>
                {[
                  ['Reused, unmodified', 'decide(), computeEv, the risk gate, the audit schema, the operator queue, the idempotency authority'],
                  ['Configured per scenario', 'the action vocabulary, the cost table, the feature set, the policy'],
                  ['B2B has its own', 'independently trained scorer, own seed, own golden-vector parity contract'],
                  ['Checkout borrows one', 'the subscription scorer — uncalibrated for abandonment, so no accuracy number is claimed'],
                ].map(([k, v]) => (
                  <tr key={k} className="border-b border-ink-line align-top">
                    <th scope="row" className="w-[15rem] py-3 pr-6 text-left font-normal text-on-ink-muted">
                      {k}
                    </th>
                    <td className="py-3 text-on-ink-soft">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-5 text-small text-on-ink-muted">
              The honest asymmetry is the last row, and it is deliberate:{' '}
              <code>docs/adr/0012</code> records why checkout abandonment reports no calibration or
              off-policy number anywhere, rather than generating a fourth synthetic dataset to
              produce a flattering one.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
