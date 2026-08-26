/**
 * The simulator's real visual diff: a dumbbell (paired dot + connector) per action
 * instead of a plain table, plus a diverging bar for the EV delta instead of two
 * numbers the reader has to subtract by hand.
 *
 * A dumbbell is the right shape here specifically because it degenerates honestly
 * when nothing moves: an unchanged policy renders as coincident dots, which is a
 * true reading of "the distribution did not change" — the same claim
 * `simulator.tsx`'s own copy already makes in words. Side-by-side bars would show
 * six near-identical pairs and read as noise instead of confirming the claim.
 *
 * Same inline-SVG house pattern as `app/model/calibration-chart.tsx`.
 */
import { linear, niceMax, ticks } from '~/_viz/scale'
import { formatMilliInr, formatSigned, deltaGlyph, ACTION_LABELS } from '~/_viz/format'

const W = 680
const ROW_H = 30
const PAD = { top: 34, right: 64, bottom: 22, left: 132 }

export function PolicyShiftChart({
  actions,
  baselineCounts,
  simulatedCounts,
}: {
  actions: readonly string[]
  baselineCounts: Readonly<Record<string, number>>
  simulatedCounts: Readonly<Record<string, number>>
}): React.JSX.Element {
  const H = PAD.top + actions.length * ROW_H + PAD.bottom
  const maxCount = niceMax(
    Math.max(1, ...actions.map((a) => Math.max(baselineCounts[a] ?? 0, simulatedCounts[a] ?? 0))),
  )
  const cx = linear(0, maxCount, PAD.left, W - PAD.right)
  const axisTicks = ticks(maxCount, 4)

  const ariaLabel = actions
    .map((a) => {
      const b = baselineCounts[a] ?? 0
      const s = simulatedCounts[a] ?? 0
      const delta = s - b
      return `${ACTION_LABELS[a] ?? a}: ${b} baseline, ${s} simulated, ${delta === 0 ? 'no change' : formatSigned(delta, String)}`
    })
    .join('; ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Action distribution shift: ${ariaLabel}`} className="w-full">
      {axisTicks.map((t) => {
        const x = cx(t)
        return (
          <g key={t}>
            <line x1={x} x2={x} y1={PAD.top - 8} y2={H - PAD.bottom} stroke="var(--color-ink-line)" strokeDasharray="2 4" />
            <text x={x} y={PAD.top - 12} textAnchor="middle" fontSize={9} fill="var(--color-on-ink-muted)">
              {t}
            </text>
          </g>
        )
      })}

      {actions.map((a, i) => {
        const y = PAD.top + i * ROW_H + ROW_H / 2
        const b = baselineCounts[a] ?? 0
        const s = simulatedCounts[a] ?? 0
        const delta = s - b
        const glyph = deltaGlyph(delta)
        const color = glyph === '▲' ? 'var(--color-pos)' : glyph === '▼' ? 'var(--color-neg)' : 'var(--color-on-ink-muted)'
        const bx = cx(b)
        const sx = cx(s)

        return (
          <g key={a}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--color-ink-line)" />
            <text x={PAD.left - 12} y={y + 3} textAnchor="end" fontSize={10} fill="var(--color-on-ink-soft)">
              {ACTION_LABELS[a] ?? a}
            </text>

            {delta === 0 ? (
              <>
                <circle cx={bx} cy={y} r={4} fill="none" stroke="var(--color-on-ink-muted)" strokeWidth={1.5} />
                <circle cx={bx} cy={y} r={1.5} fill="var(--color-on-ink-muted)" />
              </>
            ) : (
              <>
                <line x1={bx} x2={sx} y1={y} y2={y} stroke={color} strokeWidth={3} strokeLinecap="round" />
                <path
                  d={
                    sx >= bx
                      ? `M ${sx - 5},${y - 4} L ${sx - 5},${y + 4} L ${sx},${y} Z`
                      : `M ${sx + 5},${y - 4} L ${sx + 5},${y + 4} L ${sx},${y} Z`
                  }
                  fill={color}
                />
                <circle cx={bx} cy={y} r={4} fill="var(--color-ink)" stroke="var(--color-on-ink-muted)" strokeWidth={1.5} />
                <circle cx={sx} cy={y} r={4.5} fill="var(--color-accent)" />
              </>
            )}

            <text x={W - PAD.right + 8} y={y + 3} fontSize={10} className="tnum" fill={color}>
              {delta === 0 ? '=' : `${glyph} ${formatSigned(delta, String)}`}
            </text>
          </g>
        )
      })}

      <g transform={`translate(${PAD.left},${H - 6})`} fontSize={9} fill="var(--color-on-ink-muted)">
        <circle cx={4} cy={-3} r={4} fill="var(--color-ink)" stroke="var(--color-on-ink-muted)" strokeWidth={1.5} />
        <text x={14} y={0}>baseline</text>
        <circle cx={90} cy={-3} r={4.5} fill="var(--color-accent)" />
        <text x={102} y={0}>simulated</text>
      </g>
    </svg>
  )
}

const EV_W = 680
const EV_H = 92

/** A single number, one bar, no mental arithmetic — replaces two large EV figures
 * side by side with the reader expected to subtract them. */
export function EvDeltaChart({
  baselineEvMilli,
  simulatedEvMilli,
}: {
  baselineEvMilli: number
  simulatedEvMilli: number
}): React.JSX.Element {
  const delta = simulatedEvMilli - baselineEvMilli
  const glyph = deltaGlyph(delta)
  const color = glyph === '▲' ? 'var(--color-pos)' : glyph === '▼' ? 'var(--color-neg)' : 'var(--color-on-ink-muted)'
  const half = (EV_W - 40) / 2
  const zeroX = EV_W / 2
  const barScale = niceMax(Math.abs(delta))
  const barW = barScale === 0 ? 0 : (Math.abs(delta) / barScale) * half

  const ariaLabel = `Stated expected value: ${formatMilliInr(baselineEvMilli)} baseline, ${formatMilliInr(simulatedEvMilli)} simulated, a ${glyph === '=' ? 'no' : formatSigned(delta, formatMilliInr)} difference.`

  return (
    <div>
      <svg viewBox={`0 0 ${EV_W} ${EV_H}`} role="img" aria-label={ariaLabel} className="w-full">
        <line x1={zeroX} x2={zeroX} y1={16} y2={56} stroke="var(--color-ink-line)" strokeWidth={1} />
        {delta !== 0 && (
          <rect
            x={delta > 0 ? zeroX : zeroX - barW}
            y={26}
            width={barW}
            height={20}
            fill={color}
          />
        )}
        <text x={zeroX} y={12} textAnchor="middle" fontSize={13} fontWeight={700} fill={color}>
          {glyph === '=' ? 'No EV difference' : `${glyph} ${formatSigned(delta, formatMilliInr)}`}
        </text>
        <text x={20} y={76} fontSize={10} fill="var(--color-on-ink-muted)">
          baseline {formatMilliInr(baselineEvMilli)}
        </text>
        <text x={EV_W - 20} y={76} textAnchor="end" fontSize={10} fill="var(--color-accent)">
          simulated {formatMilliInr(simulatedEvMilli)}
        </text>
      </svg>
    </div>
  )
}
