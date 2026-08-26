import Link from 'next/link'
import { BatchRunner } from './batch-runner'

export const dynamic = 'force-dynamic'

/*
 * The dashboard shell (BUILD_PLAN.md's D9 row): the batch runner, streaming
 * counters, and every SYSTEM_SPEC.md §13 metric, in the Champagne-on-Ink
 * design system from BUILD_PLAN.md §3. The audit table, EV explorer, model
 * page, and queue page (D10) all now exist too — this page stays deliberately
 * just the shell and the one thing it exists to demonstrate: click Run batch,
 * watch it happen.
 */
export default function DashboardPage(): React.JSX.Element {
  return (
    <main id="main">
      <section className="bg-ink px-gutter pt-8 pb-band">
        <nav className="mx-auto flex max-w-[1240px] items-center justify-between">
          <Link href="/" className="display text-[1.0625rem] tracking-[0.06em] uppercase">
            Reclaim
          </Link>
          <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">Dashboard</span>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">Batch runner</span>
          <h1 className="display mt-7 max-w-[22ch] text-section">
            Run a batch, watch the <span className="text-on-ink-dim">decision engine</span> work
          </h1>
          <p className="mt-6 max-w-[62ch] text-body text-on-ink-soft">
            Every event is a synthetic, signed <code>payment.failed</code> delivery through the real
            webhook path — the same signature verification, queue, and worker a live delivery would
            hit. Always dry-run, structurally, regardless of which credentials are present
            (BUILD_PLAN.md §5.3).
          </p>

          <div className="mt-14">
            <BatchRunner />
          </div>
        </div>
      </section>
    </main>
  )
}
