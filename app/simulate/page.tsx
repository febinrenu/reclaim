import Link from 'next/link'
import { Simulator } from './simulator'

export const dynamic = 'force-dynamic'

/*
 * D12's policy simulator (BUILD_PLAN.md §1.4 point 1): "replay a stored batch
 * through the decision engine offline with no side effects, and diff the
 * resulting metrics against the baseline run." The proof the system is
 * genuinely optimising rather than running a dressed-up rule chain — a
 * reviewer watches the chosen-action distribution shift as the economics
 * change, entirely offline.
 */
export default function SimulatePage(): React.JSX.Element {
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
            <span className="text-accent">Simulate</span>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">Policy simulator</span>
          <h1 className="display mt-7 max-w-[26ch] text-section">
            Change the economics, <span className="text-on-ink-dim">watch the decisions shift</span>
          </h1>
          <p className="mt-6 max-w-[68ch] text-body text-on-ink-soft">
            Replays a stored batch through the exact same decision engine under a different policy
            — no side effects, no audit rows written, no payments client called. Proof this is a
            real optimisation, not a dressed-up rule chain.
          </p>

          <div className="mt-14">
            <Simulator />
          </div>
        </div>
      </section>
    </main>
  )
}
