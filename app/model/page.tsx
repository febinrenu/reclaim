import Link from 'next/link'
import { MODEL_DATA } from './model-data'
import { ReliabilityCurve, PredictionHistogram, MetricsTable } from './calibration-chart'

export const dynamic = 'force-static'

/*
 * D10's model page: the calibration curve, in-app, plus the full metric set
 * BUILD_PLAN.md §6.6 asks for. Static — `recovery_model.json` is a committed
 * build artifact (`npm run scorer:train`), not something this page queries live.
 */
export default function ModelPage(): React.JSX.Element {
  const { metrics, featureOrder, coefficients, intercept, plattA, plattB, goldenVectors, trainedOn } = MODEL_DATA

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
            <span className="text-accent">Model</span>
            <Link href="/queue" className="hover:text-accent">
              Queue
            </Link>
            <Link href="/simulate" className="hover:text-accent">
              Simulate
            </Link>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">Recovery scorer</span>
          <h1 className="display mt-7 max-w-[26ch] text-section">
            A probability, and the <span className="text-on-ink-dim">receipt</span> behind it
          </h1>
          <p className="mt-6 max-w-[68ch] text-body text-on-ink-soft">
            Logistic regression, {featureOrder.length} terms, trained on {trainedOn.nTrain} logged
            rows, calibrated on {trainedOn.nCalibration}, and every number below computed on the{' '}
            {trainedOn.nDemo}-row demo split — the one split whose numbers are allowed to appear
            anywhere (BUILD_PLAN.md §6.6).
          </p>

          <div className="mt-14 grid gap-10 lg:grid-cols-2">
            <div>
              <span className="eyebrow text-on-ink-muted">Reliability curve</span>
              <p className="mt-4 text-small text-on-ink-muted">
                10 equal-frequency bins, Wilson 95% intervals. The dashed line is perfect
                calibration.
              </p>
              <div className="mt-6">
                <ReliabilityCurve bins={metrics.calibration_bins} />
              </div>
            </div>

            <div>
              <span className="eyebrow text-on-ink-muted">Where the predictions land</span>
              <p className="mt-4 text-small text-on-ink-muted">
                Predictions pile up under 0.30 — most failed payments are genuinely unlikely to
                recover.
              </p>
              <div className="mt-6">
                <PredictionHistogram counts={metrics.prediction_histogram.counts} binEdges={metrics.prediction_histogram.binEdges} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-paper px-gutter py-band text-on-paper">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-on-paper-muted">Metrics, logged_demo only</span>
          <h2 className="display mt-7 max-w-[30ch] text-section">
            Discrimination and calibration, <span className="text-on-paper-dim">reported honestly</span>
          </h2>

          <div className="mt-10 bg-card p-8">
            <MetricsTable metrics={metrics} />
          </div>

          <p className="mt-6 max-w-[76ch] text-small text-on-paper-muted">
            BSS of {metrics.bss.toFixed(3)} means the model captures{' '}
            {(metrics.bss * 100).toFixed(0)}% of the skill available over the base-rate reference —
            a deliberately imperfect number: `eval/test_generator_difficulty.py` fails CI if this
            ever gets too easy for the comparison to mean anything. Full account in
            docs/EVALUATION.md.
          </p>
        </div>
      </section>

      <section className="bg-ink px-gutter py-band">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-on-ink-muted">The coefficients themselves</span>
          <h2 className="display mt-7 max-w-[26ch] text-section">
            Readable as JSON, <span className="text-on-ink-dim">not a compiled blob</span>
          </h2>
          <p className="mt-6 max-w-[68ch] text-small text-on-ink-muted">
            Intercept {intercept.toFixed(4)}, Platt A/B {plattA.toFixed(4)} / {plattB.toFixed(4)}.{' '}
            {goldenVectors.length} golden vectors are committed alongside these coefficients and
            checked to 1e-12 against an independent TypeScript port
            (`tests/unit/scorer.parity.test.ts`).
          </p>

          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[640px] border-t border-ink-line text-small">
              <caption className="sr-only">Every model coefficient, in feature order</caption>
              <thead>
                <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                  <th scope="col" className="py-2 text-left font-normal">
                    Term
                  </th>
                  <th scope="col" className="py-2 text-right font-normal">
                    Coefficient
                  </th>
                </tr>
              </thead>
              <tbody>
                {featureOrder.map((f, i) => (
                  <tr key={f} className="border-b border-ink-line">
                    <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                      {f}
                    </th>
                    <td className="py-2 text-right tnum">{coefficients[i]?.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  )
}
