import { getDeps } from '@/server/di'
import { VERSION } from '@/config/version'

export const dynamic = 'force-dynamic'

/**
 * Day one placeholder. Its only job is to prove the wiring is real: the capability
 * table it renders is read from the live container, not hardcoded.
 *
 * The batch metrics, decision ledger, and EV explorer land on D9 and D10.
 */
export default function Home() {
  const { capabilities } = getDeps()

  const mode = capabilities.fullyLocal
    ? 'local, zero credentials'
    : capabilities.allLive
      ? 'fully live'
      : 'mixed'

  return (
    <main id="main" className="mx-auto max-w-[1100px] px-6 py-10">
      <header className="mb-8 border-b border-rule pb-4">
        <div className="flex items-baseline justify-between">
          <h1 className="font-label text-[38px] leading-none tracking-[0.02em] text-fg uppercase">
            Reclaim
          </h1>
          <span className="label">
            v{VERSION} &nbsp; {mode}
          </span>
        </div>
        <p className="mt-3 max-w-[62ch] font-sans text-[13px] leading-relaxed text-fg-muted">
          Most recovery systems ask whether a payment will fail. Reclaim asks whether
          recovering it is worth the money and the risk, and it is explicitly allowed
          to do nothing.
        </p>
      </header>

      <section aria-labelledby="ports-heading">
        <h2 id="ports-heading" className="label mb-3">
          Configuration
        </h2>
        <div className="hairgrid grid-cols-1 border border-rule">
          {capabilities.rows.map((row) => (
            <div key={row.port} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2">
              <span
                className="w-10 shrink-0 text-[10px] tracking-wider uppercase"
                style={{ color: row.live ? 'var(--color-positive)' : 'var(--color-fg-faint)' }}
              >
                {/* A glyph carries the state as well as the colour, so colour is never alone. */}
                {row.live ? '+ live' : '- sim'}
              </span>
              <span className="w-28 shrink-0 text-fg">{row.port}</span>
              <span className="w-32 shrink-0 text-accent">{row.adapter}</span>
              <span className="font-sans text-[12px] text-fg-muted">{row.reason}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-8 border-t border-rule pt-4">
        <p className="font-sans text-[12px] text-fg-faint">
          Day one skeleton. The decision engine, the audit ledger, and the expected-value
          explorer are not built yet. See BUILD_PLAN.md for the sequence.
        </p>
      </footer>
    </main>
  )
}
