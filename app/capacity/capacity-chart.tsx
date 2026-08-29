/**
 * The budget → net-recovery curve, hand-rolled SVG — same "no charting
 * library on the critical path" rule as `app/model/calibration-chart.tsx`,
 * and the same discipline of putting every chart's own data in a table right
 * beneath it (BUILD_PLAN.md §3.8).
 */
import type { SweepPoint } from './capacity-data'

const W = 640
const H = 360
const PAD = { top: 16, right: 16, bottom: 40, left: 56 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

export function CapacityCurve({
  points,
  bestBudget,
  unconstrainedBudget,
}: {
  points: readonly SweepPoint[]
  bestBudget: number
  unconstrainedBudget: number
}): React.JSX.Element {
  const maxBudget = unconstrainedBudget
  const values = points.map((p) => p.net_recovery_inr_per_txn)
  const minV = Math.min(...values)
  const maxV = Math.max(...values)
  const pad = (maxV - minV) * 0.08 || 1

  function x(budget: number): number {
    return PAD.left + (budget / maxBudget) * PLOT_W
  }
  function y(v: number): number {
    return PAD.top + (1 - (v - minV + pad) / (maxV - minV + 2 * pad)) * PLOT_H
  }

  const sorted = [...points].sort((a, b) => a.budget - b.budget)
  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.budget).toFixed(1)} ${y(p.net_recovery_inr_per_txn).toFixed(1)}`).join(' ')
  const best = points.find((p) => p.budget === bestBudget)
  const unconstrained = points.find((p) => p.budget === unconstrainedBudget)
  const yTicks = 5

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Net recovery per transaction as a function of the daily escalation budget"
        className="w-full"
      >
        <line x1={x(0)} y1={PAD.top + PLOT_H} x2={x(maxBudget)} y2={PAD.top + PLOT_H} stroke="var(--color-ink-line)" />
        <line x1={x(0)} y1={PAD.top} x2={x(0)} y2={PAD.top + PLOT_H} stroke="var(--color-ink-line)" />

        {Array.from({ length: yTicks + 1 }, (_, i) => minV - pad + ((maxV - minV + 2 * pad) * i) / yTicks).map((v) => (
          <g key={v}>
            <line x1={x(0)} y1={y(v)} x2={x(maxBudget)} y2={y(v)} stroke="var(--color-ink-line)" strokeOpacity={0.3} />
            <text x={x(0) - 8} y={y(v) + 3} fontSize="9" fill="var(--color-on-ink-muted)" textAnchor="end">
              ₹{v.toFixed(0)}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <text
            key={t}
            x={x(t * maxBudget)}
            y={PAD.top + PLOT_H + 16}
            fontSize="9"
            fill="var(--color-on-ink-muted)"
            textAnchor="middle"
          >
            {Math.round(t * maxBudget)}
          </text>
        ))}
        <text x={x(maxBudget / 2)} y={H - 4} fontSize="10" fill="var(--color-on-ink-muted)" textAnchor="middle">
          daily escalation budget
        </text>
        <text
          x={14}
          y={PAD.top + PLOT_H / 2}
          fontSize="10"
          fill="var(--color-on-ink-muted)"
          textAnchor="middle"
          transform={`rotate(-90 14 ${PAD.top + PLOT_H / 2})`}
        >
          ₹/txn
        </text>

        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} />

        {unconstrained !== undefined && (
          <g>
            <circle cx={x(unconstrained.budget)} cy={y(unconstrained.net_recovery_inr_per_txn)} r={3.5} fill="var(--color-on-ink-muted)" />
            <text
              x={x(unconstrained.budget) - 6}
              y={y(unconstrained.net_recovery_inr_per_txn) - 10}
              fontSize="9"
              fill="var(--color-on-ink-muted)"
              textAnchor="end"
            >
              unconstrained
            </text>
          </g>
        )}
        {best !== undefined && (
          <g>
            <circle cx={x(best.budget)} cy={y(best.net_recovery_inr_per_txn)} r={4} fill="var(--color-pos-bright)" />
            <text x={x(best.budget) + 8} y={y(best.net_recovery_inr_per_txn) - 6} fontSize="9" fill="var(--color-pos)" textAnchor="start">
              peak
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}
