/**
 * The reliability curve plus prediction histogram, in-app — BUILD_PLAN.md's D10
 * row: "no charting library on the critical path." Same two-panel shape and
 * same 10 equal-frequency bins with Wilson 95% intervals as
 * `docs/calibration_recovery_v1.png` (`scripts/data/train_scorer.py`'s
 * `_make_calibration_chart`), since both read `recovery_model.json`'s
 * `calibration_bins`/`prediction_histogram` — one source of bin data, so the
 * static PNG and this SVG can never silently disagree.
 *
 * Every chart here also has the identical data as a table beneath it
 * (BUILD_PLAN.md §3.8: "every chart needs the same data reachable as a table").
 */
import type { CalibrationBin, ModelMetrics } from './model-data'

const W = 560
const H = 360
const PAD = { top: 16, right: 16, bottom: 40, left: 48 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

function x(v: number): number {
  return PAD.left + v * PLOT_W
}
function y(v: number): number {
  return PAD.top + (1 - v) * PLOT_H
}

export function ReliabilityCurve({ bins }: { bins: readonly CalibrationBin[] }): React.JSX.Element {
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Reliability curve: predicted versus observed recovery rate, with 95% confidence intervals" className="w-full">
        {/* Axes */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} stroke="var(--color-ink-line)" />
        <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} stroke="var(--color-ink-line)" />
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <text x={x(t)} y={y(0) + 16} fontSize="9" fill="var(--color-on-ink-muted)" textAnchor="middle">
              {t.toFixed(2)}
            </text>
            <text x={x(0) - 8} y={y(t) + 3} fontSize="9" fill="var(--color-on-ink-muted)" textAnchor="end">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        <text x={x(0.5)} y={H - 4} fontSize="10" fill="var(--color-on-ink-muted)" textAnchor="middle">
          predicted P(recover)
        </text>
        <text
          x={12}
          y={PAD.top + PLOT_H / 2}
          fontSize="10"
          fill="var(--color-on-ink-muted)"
          textAnchor="middle"
          transform={`rotate(-90 12 ${PAD.top + PLOT_H / 2})`}
        >
          observed rate
        </text>

        {/* Perfect-calibration diagonal */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--color-on-ink-faint)" strokeDasharray="4 4" />

        {/* Wilson CI whiskers + points */}
        {bins.map((b, i) => (
          <g key={i}>
            <line
              x1={x(b.meanPredicted)}
              y1={y(Math.max(0, b.wilsonLow))}
              x2={x(b.meanPredicted)}
              y2={y(Math.min(1, b.wilsonHigh))}
              stroke="var(--color-accent-dim)"
              strokeWidth={1.5}
            />
            <circle cx={x(b.meanPredicted)} cy={y(b.observedRate)} r={4} fill="var(--color-accent)" />
          </g>
        ))}
      </svg>

      <table className="mt-4 w-full border-t border-ink-line text-small">
        <caption className="sr-only">Reliability curve data: predicted and observed recovery rate per bin</caption>
        <thead>
          <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
            <th scope="col" className="py-2 text-left font-normal">
              Bin
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              n
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              Predicted
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              Observed
            </th>
            <th scope="col" className="py-2 text-right font-normal">
              95% CI
            </th>
          </tr>
        </thead>
        <tbody>
          {bins.map((b, i) => (
            <tr key={i} className="border-b border-ink-line">
              <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                {i + 1}
              </th>
              <td className="py-2 text-right tnum">{b.n}</td>
              <td className="py-2 text-right tnum">{(b.meanPredicted * 100).toFixed(1)}%</td>
              <td className="py-2 text-right tnum">{(b.observedRate * 100).toFixed(1)}%</td>
              <td className="py-2 text-right tnum text-on-ink-muted">
                [{(b.wilsonLow * 100).toFixed(1)}%, {(b.wilsonHigh * 100).toFixed(1)}%]
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PredictionHistogram({
  counts,
  binEdges,
}: {
  counts: readonly number[]
  binEdges: readonly number[]
}): React.JSX.Element {
  const maxCount = Math.max(1, ...counts)
  const barW = PLOT_W / counts.length

  return (
    <div>
      <svg viewBox={`0 0 ${W} 160`} role="img" aria-label="Histogram of predicted recovery probabilities" className="w-full">
        <line x1={PAD.left} y1={160 - 24} x2={W - PAD.right} y2={160 - 24} stroke="var(--color-ink-line)" />
        {counts.map((c, i) => {
          const h = (c / maxCount) * (160 - 40)
          return (
            <rect
              key={i}
              x={PAD.left + i * barW + 1}
              y={160 - 24 - h}
              width={Math.max(0, barW - 2)}
              height={h}
              fill="var(--color-accent)"
            />
          )
        })}
        <text x={PAD.left} y={158} fontSize="9" fill="var(--color-on-ink-muted)">
          {binEdges[0]?.toFixed(2)}
        </text>
        <text x={W - PAD.right} y={158} fontSize="9" fill="var(--color-on-ink-muted)" textAnchor="end">
          {binEdges[binEdges.length - 1]?.toFixed(2)}
        </text>
      </svg>
    </div>
  )
}

export function MetricsTable({ metrics }: { metrics: ModelMetrics }): React.JSX.Element {
  const rows: readonly [string, string][] = [
    ['n (train / calibration / demo)', `${metrics.n_train} / — / ${metrics.n_demo}`],
    ['Base rate (train)', `${(metrics.train_base_rate * 100).toFixed(1)}%`],
    ['Brier score (after Platt)', metrics.brier_after_platt.toFixed(4)],
    ['Brier score (before Platt)', metrics.brier_before_platt.toFixed(4)],
    ['Brier skill score (BSS)', metrics.bss.toFixed(4)],
    ['ROC-AUC', metrics.roc_auc.toFixed(4)],
    ['ECE @ k=5 / 10 / 20', `${metrics.ece['5']?.toFixed(4)} / ${metrics.ece['10']?.toFixed(4)} / ${metrics.ece['20']?.toFixed(4)}`],
    ['MCE (k=10)', metrics.mce_k10.toFixed(4)],
    ['Murphy: reliability / resolution / uncertainty', `${metrics.murphy_decomposition.reliability.toFixed(4)} / ${metrics.murphy_decomposition.resolution.toFixed(4)} / ${metrics.murphy_decomposition.uncertainty.toFixed(4)}`],
  ]
  return (
    <table className="w-full border-t border-paper-line text-small">
      <caption className="sr-only">Recovery scorer metrics, computed on logged_demo only</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-paper-line">
            <th scope="row" className="py-2 text-left font-normal text-on-paper-muted">
              {label}
            </th>
            <td className="py-2 text-right tnum font-bold">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
