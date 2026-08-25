import Link from 'next/link'
import { getDeps } from '@/server/di'
import { VERSION } from '@/config/version'

export const dynamic = 'force-dynamic'

/*
 * Structure follows the reference in frontend-design-inspiration/: full-bleed bands
 * alternating true black and light grey, each opened by a pill eyebrow, headings in
 * heavy tight display type with a two-tone treatment, rows numbered [ 01 ] against a
 * hairline rule, white cards on grey separated by contrast rather than borders, and a
 * giant champagne wordmark bleeding across the footer.
 *
 * The content is Reclaim's own and every figure on this page is true today. There is
 * deliberately no recovery-rate or revenue number anywhere, because the decision
 * engine does not exist yet and inventing a headline metric to fill a hero would be
 * the one thing this project cannot afford to do.
 */

const RESPONSIBILITIES = [
  {
    n: '01',
    kind: 'Deterministic',
    title: 'Money and state',
    body:
      'State transitions, retry limits, the expected-value arithmetic, idempotency, ' +
      'stopping rules, the audit trail, and every payments API call.',
    points: [
      'Plain TypeScript, unit tested',
      'No model anywhere in the path',
      'Integer paise, never floats',
      'Replayable from a stored input',
    ],
  },
  {
    n: '02',
    kind: 'Statistical',
    title: 'Recovery probability',
    body:
      'A calibrated probability that a failed payment is recoverable, trained offline ' +
      'and checked against a reliability curve rather than assumed.',
    points: [
      'Logistic regression, 25 terms',
      'Calibration checked, not claimed',
      'Runs in process, sub-millisecond',
      'Coefficients readable as JSON',
    ],
  },
  {
    n: '03',
    kind: 'Generative',
    title: 'Language, and only language',
    body:
      'Drafts the recovery message and writes the sentence explaining a decision that ' +
      'has already been made. It never chooses an action.',
    points: [
      'Cannot reach a payments client',
      'Enforced by type, not by comment',
      'Deterministic template fallback',
      'Decide first, then speak',
    ],
  },
] as const

/* Every count here is real and checkable by running the command named beside it. */
const EVIDENCE = [
  { label: 'Unit and property tests', value: '323', note: 'npm test' },
  { label: 'CI jobs, all green', value: '4', note: 'Linux and Windows' },
  { label: 'Secrets needed to run it', value: '0', note: 'empty .env' },
  { label: 'Boundary rules enforced', value: '4', note: 'plus a purity gate' },
] as const

/* Test counts per module, for the bar chart. Sums to the 77 reported above. */
const TEST_SPREAD = [
  { module: 'money', n: 21 },
  { module: 'config', n: 20 },
  { module: 'rng', n: 15 },
  { module: 'json', n: 14 },
  { module: 'purity', n: 7 },
] as const

export default async function Home() {
  const { capabilities } = await getDeps()

  const mode = capabilities.fullyLocal
    ? 'Local, zero credentials'
    : capabilities.allLive
      ? 'Fully live'
      : 'Mixed, some ports live'

  const maxTests = Math.max(...TEST_SPREAD.map((t) => t.n))

  return (
    <main id="main">
      {/* ───────────────────────── HERO, black ───────────────────────── */}
      <section className="bg-ink px-gutter pt-8 pb-band">
        <nav className="mx-auto flex max-w-[1240px] items-start justify-between">
          <span className="display text-[1.0625rem] tracking-[0.06em] uppercase">Reclaim</span>
          <div className="text-right text-[0.625rem] leading-[1.9] tracking-[0.11em] uppercase">
            <Link href="/dashboard" className="text-accent hover:opacity-80">
              Run a batch →
            </Link>
            <div className="text-on-ink-muted">Audit ledger</div>
            <div className="text-on-ink-muted">Policy simulator</div>
          </div>
        </nav>

        <div className="mx-auto mt-band max-w-[1240px]">
          <div className="flex flex-col items-center text-center">
            <span className="eyebrow text-accent">Track: AI Revenue Recovery</span>

            <h1 className="display mt-9 max-w-[17ch] text-hero text-accent">
              Recover what is <span className="text-on-ink-dim">worth</span> recovering
            </h1>
          </div>

          <p className="mx-auto mt-9 max-w-[58ch] text-center text-body text-on-ink-soft">
            Most systems in this space predict whether a payment will fail. Reclaim asks a
            different question: given a payment has already failed, is it worth spending money
            and risk to get it back, and if so, how?
          </p>

          {/* The formula, framed like the reference's inset hero card. */}
          <div className="mt-14 grid gap-px bg-ink-line lg:grid-cols-[1.35fr_1fr]">
            <div className="bg-ink-raised p-8">
              <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                The decision rule
              </span>
              <pre className="mt-6 overflow-x-auto text-small leading-[1.85] text-on-ink-soft">
                <code>
                  {`EV(a) = P(recover | s, a) × RecoverableAmount
        − InterventionCost(a)
        − ComputeCost(a)
        − RiskPenalty(s, a)
        − ContactFatigueCost(s, a)

choose a* = argmax EV(a)`}
                </code>
              </pre>
            </div>

            <div className="flex flex-col justify-between bg-ink-raised p-8">
              <div>
                <span className="text-[0.625rem] tracking-[0.11em] text-accent uppercase">
                  Why it is allowed to do nothing
                </span>
                <p className="mt-5 text-small leading-relaxed text-on-ink-soft">
                  Doing nothing is not zero. Customers retry on their own, so the real quantity
                  is the uplift of acting over not acting. Treating it as zero would credit every
                  intervention with recovery that would have happened anyway.
                </p>
              </div>
              <p className="mt-8 text-[0.625rem] tracking-[0.11em] text-accent-dim uppercase">
                Every action is priced, including none
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ──────────────── CONFIGURATION, black, numbered rows ──────────────── */}
      <section className="bg-ink px-gutter pb-band">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-on-ink-muted">Configuration</span>
          <div className="mt-7 flex flex-wrap items-end justify-between gap-6">
            <h2 className="display max-w-[16ch] text-section">What runs where</h2>
            <p className="max-w-[42ch] text-small text-on-ink-muted">
              Every dependency has a real adapter and a local one, chosen by whether a credential
              is present. Absent is never an error. This instance is running in{' '}
              <span className="text-accent">{mode.toLowerCase()}</span>.
            </p>
          </div>

          <ul className="mt-14">
            {capabilities.rows.map((row, i) => (
              <li key={row.port} className="border-t border-ink-line py-5">
                <div className="flex items-baseline justify-between gap-6">
                  <span className="text-small font-bold">{row.port}</span>
                  <span className="numeral text-on-ink-muted">
                    [ {String(i + 1).padStart(2, '0')} ]
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                  <span className="display text-sub text-accent">{row.adapter}</span>
                  <span
                    className="text-[0.625rem] tracking-[0.11em] uppercase"
                    style={{ color: row.live ? 'var(--color-pos)' : 'var(--color-on-ink-muted)' }}
                  >
                    {/* A glyph carries the state as well as the colour. */}
                    {row.live ? '+ live' : '– simulated'}
                  </span>
                </div>
                <p className="mt-3 max-w-[68ch] text-small text-on-ink-muted">{row.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ──────────────── EVIDENCE, light, white cards ──────────────── */}
      <section className="bg-paper px-gutter py-band text-on-paper">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-on-paper-muted">Nine days in</span>

          <h2 className="display mt-7 max-w-[30ch] text-section">
            Built so far, and{' '}
            <span className="text-on-paper-dim">
              every number here is checkable by running the command beside it
            </span>
          </h2>

          <div className="mt-14 grid gap-6 lg:grid-cols-[1.15fr_1fr]">
            {/* Bar chart, champagne on white, as in the reference metrics card. */}
            <div className="bg-card p-8">
              <span className="eyebrow text-on-paper-muted">Test coverage, day one's modules</span>
              <p className="display mt-6 max-w-[22ch] text-[1.75rem] leading-[1.1]">
                323 tests today, and real bugs found by running the exit tests, not by assuming
                they&apos;d pass
              </p>

              <div className="mt-10 flex h-[168px] items-end gap-4" aria-hidden="true">
                {TEST_SPREAD.map((t) => (
                  <div key={t.module} className="flex flex-1 flex-col items-center gap-3">
                    {/* Champagne fill under a paler cap, as the reference bars do. */}
                    <div
                      className="flex w-full flex-col justify-end"
                      style={{ height: `${(t.n / maxTests) * 130}px` }}
                    >
                      <div className="h-2 w-full bg-accent-deep/35" />
                      <div className="flex-1 w-full bg-accent" />
                    </div>
                    <span className="text-[0.625rem] text-on-paper-muted">{t.module}</span>
                  </div>
                ))}
              </div>

              {/* The same data as a table, so the chart is never the only route to it. */}
              <table className="mt-8 w-full border-t border-paper-line text-small">
                <caption className="sr-only">Unit and property tests per module</caption>
                <tbody>
                  {TEST_SPREAD.map((t) => (
                    <tr key={t.module} className="border-b border-paper-line">
                      <th scope="row" className="py-2 text-left font-normal">
                        {t.module}
                      </th>
                      <td className="py-2 text-right font-bold">{t.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Evidence tiles. */}
            <div className="grid gap-6 sm:grid-cols-2">
              {EVIDENCE.map((e) => (
                <div key={e.label} className="flex flex-col justify-between bg-card p-7">
                  <span className="text-[0.625rem] tracking-[0.11em] text-on-paper-muted uppercase">
                    {e.label}
                  </span>
                  <div className="mt-10">
                    <span className="display text-[3rem] leading-none">{e.value}</span>
                    <p className="mt-2 text-small text-on-paper-muted">{e.note}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-10 max-w-[76ch] text-small text-on-paper-muted">
            Built since: the decision engine, the trained recovery scorer, the webhook and worker,
            the off-policy evaluation estimators, the language layer, and the{' '}
            <Link href="/dashboard" className="text-accent hover:opacity-80">
              batch runner
            </Link>
            . Not yet built: the audit-table and EV-explorer pages, the policy simulator, and the
            second scenario. The sequence and the reasoning behind each choice are in
            BUILD_PLAN.md.
          </p>
        </div>
      </section>

      {/* ──────────────── RESPONSIBILITIES, black ──────────────── */}
      <section className="bg-ink px-gutter py-band">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-on-ink-muted">Boundaries</span>
          <h2 className="display mt-7 max-w-[22ch] text-section">
            Where the model is, and where it deliberately is not
          </h2>

          <div className="mt-16">
            {RESPONSIBILITIES.map((r) => (
              <article key={r.n} className="border-t border-ink-line pt-5 pb-14">
                <div className="flex items-baseline justify-between gap-6">
                  <span className="text-small font-bold">{r.kind}</span>
                  <span className="numeral text-on-ink-muted">[ {r.n} ]</span>
                </div>

                <div className="mt-6 grid gap-10 lg:grid-cols-[1.3fr_1fr]">
                  <div>
                    <h3 className="display text-sub">{r.title}</h3>
                    <p className="mt-5 max-w-[52ch] text-small text-on-ink-muted">{r.body}</p>
                  </div>
                  <ul className="space-y-3 self-end">
                    {r.points.map((p) => (
                      <li key={p} className="flex items-baseline gap-3 text-small text-on-ink-soft">
                        <span aria-hidden="true" className="text-accent">
                          +
                        </span>
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            ))}
          </div>

          <div className="bracketed mt-6 px-6 py-20 text-center">
            <p className="display mx-auto max-w-[26ch] text-section">
              The language layer <span className="text-on-ink-dim">cannot</span> reach a
              payments client
            </p>
            <p className="mx-auto mt-7 max-w-[62ch] text-small text-on-ink-muted">
              Enforced five ways, two of them at the type level, and one of them an ordering
              guarantee stronger than the rest: the decision has already been made before any
              language call happens, and the result carries no action field.
            </p>
          </div>
        </div>
      </section>

      {/* ──────────────── FOOTER, giant wordmark ──────────────── */}
      <footer className="bg-ink px-gutter pb-12">
        <div className="mx-auto max-w-[1240px]">
          <div
            className="display leading-[0.78] text-accent"
            style={{ fontSize: 'clamp(4rem, 19vw, 17rem)', letterSpacing: '-0.04em' }}
            aria-hidden="true"
          >
            RECLAIM
          </div>

          <div className="mt-12 grid gap-10 border-t border-ink-line pt-10 sm:grid-cols-3">
            <p className="max-w-[38ch] text-small text-on-ink-muted">
              Risk-aware revenue recovery. It prices every recovery action, including doing
              nothing.
            </p>
            <div className="text-small">
              <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                Reference
              </span>
              <ul className="mt-4 space-y-2 text-on-ink-soft">
                <li>BUILD_PLAN.md</li>
                <li>SYSTEM_SPEC.md</li>
                <li>docs/INCIDENTS.md</li>
              </ul>
            </div>
            <div className="text-small sm:text-right">
              <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                Constraints
              </span>
              <ul className="mt-4 space-y-2 text-on-ink-soft">
                <li>Synthetic data only</li>
                <li>Test-mode credentials only</li>
                <li>Bounded, reversible actions</li>
              </ul>
            </div>
          </div>

          <div className="mt-10 flex flex-wrap justify-between gap-4 text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
            <span>Version {VERSION}</span>
            <span>{mode}</span>
          </div>
        </div>
      </footer>
    </main>
  )
}
