/**
 * The dashboard's before/after moment, drawn rather than left as a two-row table:
 * how much retry-everything (naive) recovered against how much Reclaim recovered,
 * against the real ceiling (everything at risk) — and, the other half of the
 * argument, what each policy actually spent to get there. Without the spend panel
 * this chart would argue against the product: naive, which retries every failure,
 * routinely recovers more GROSS revenue under common random numbers, because it
 * tries everyone. The real claim is comparable recovery at a fraction of the spend
 * and far fewer customers contacted — so both panels are required, not decorative.
 *
 * Same inline-SVG house pattern as `app/model/calibration-chart.tsx` — module-local
 * layout constants, no charting library (BUILD_PLAN.md §3.4), plain `fill="var(...)"`
 * SVG attributes rather than Tailwind's arbitrary-value classes, matching that file.
 */
import { linear, niceMax } from '~/_viz/scale'
import { formatPaise, formatMilliInr, deltaGlyph } from '~/_viz/format'

const W = 760
const H = 300
const LABEL_W = 132
const RECOVERED_W = 400
const GAP = 40
const SPEND_W = W - LABEL_W - RECOVERED_W - GAP
const BAR_H = 26
const ROW_Y = [96, 152] as const
const BRACKET_Y = ROW_Y[1] + BAR_H + 10

export function BaselineChart({
  revenueAtRiskPaise,
  naiveRecoveredPaise,
  reclaimRecoveredPaise,
  naiveAttempts,
  naiveGatewayFeePaise,
  reclaimInterventionMilli,
  reclaimGatewayFeePaise,
  reclaimTouched,
  totalCount,
}: {
  revenueAtRiskPaise: number
  naiveRecoveredPaise: number
  reclaimRecoveredPaise: number
  naiveAttempts: number
  naiveGatewayFeePaise: number
  reclaimInterventionMilli: number
  reclaimGatewayFeePaise: number
  reclaimTouched: number
  totalCount: number
}): React.JSX.Element {
  const recoveredX = linear(0, Math.max(1, revenueAtRiskPaise), 0, RECOVERED_W)

  const reclaimInterventionPaise = reclaimInterventionMilli / 1000
  const naiveSpendPaise = naiveGatewayFeePaise
  const reclaimSpendPaise = reclaimInterventionPaise + reclaimGatewayFeePaise
  const spendMax = niceMax(Math.max(naiveSpendPaise, reclaimSpendPaise))
  const spendX = linear(0, spendMax, 0, SPEND_W)

  const naiveBarW = Math.max(0, recoveredX(naiveRecoveredPaise))
  const reclaimBarW = Math.max(0, recoveredX(reclaimRecoveredPaise))
  const deltaPaise = reclaimRecoveredPaise - naiveRecoveredPaise
  const glyph = deltaGlyph(deltaPaise)
  const bracketColor =
    glyph === '▲' ? 'var(--color-pos)' : glyph === '▼' ? 'var(--color-neg)' : 'var(--color-on-ink-muted)'
  const bracketX1 = naiveBarW
  const bracketX2 = reclaimBarW
  const bracketMidCollides = Math.abs(bracketX2 - bracketX1) < 48
  const bracketLabelX = bracketMidCollides ? Math.max(bracketX1, bracketX2) + 8 : (bracketX1 + bracketX2) / 2
  const bracketAnchor: 'start' | 'middle' = bracketMidCollides ? 'start' : 'middle'

  const recoveredOrigin = LABEL_W
  const spendOrigin = LABEL_W + RECOVERED_W + GAP

  const reclaimInterventionW = Math.max(0, spendX(reclaimInterventionPaise))
  const reclaimGatewayW = Math.max(0, spendX(reclaimGatewayFeePaise))

  const ariaLabel =
    'Recovered, model-implied: each figure is drawn against the predicted recovery ' +
    'probability of the action that policy chose, so this comparison is a projection ' +
    'under this model rather than a measurement. ' +
    `Retry-everything recovered ${formatPaise(naiveRecoveredPaise)} from ${naiveAttempts} attempts; ` +
    `Reclaim recovered ${formatPaise(reclaimRecoveredPaise)} from ${reclaimTouched} of ${totalCount} contacted, ` +
    `a difference of ${formatPaise(Math.abs(deltaPaise))} ${glyph === '▲' ? 'more' : glyph === '▼' ? 'less' : '(no difference)'}, ` +
    `against ${formatPaise(revenueAtRiskPaise)} at risk. ` +
    `Spend: retry-everything spent ${formatPaise(naiveSpendPaise)} on gateway fees; ` +
    `Reclaim spent ${formatMilliInr(reclaimInterventionMilli)} in intervention cost plus ${formatPaise(reclaimGatewayFeePaise)} in gateway fees.`

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="w-full">
        {/* ── Recovered panel. Labelled as a projection here too: this chart is the most
             prominent rendering of the number in the whole product, and it said nothing
             while the tile directly above it already carried the caveat. ── */}
        <text x={recoveredOrigin} y={72} fill="var(--color-on-ink-muted)" fontSize={9} letterSpacing="0.11em">
          RECOVERED · MODEL-IMPLIED
        </text>
        <line
          x1={recoveredOrigin + RECOVERED_W}
          x2={recoveredOrigin + RECOVERED_W}
          y1={80}
          y2={ROW_Y[1] + BAR_H}
          stroke="var(--color-ink-line)"
          strokeDasharray="2 3"
        />
        <text x={recoveredOrigin + RECOVERED_W} y={72} textAnchor="end" fill="var(--color-on-ink-muted)" fontSize={9}>
          ceiling · {formatPaise(revenueAtRiskPaise)} at risk
        </text>

        {(['naive', 'reclaim'] as const).map((row, i) => {
          const y = ROW_Y[i] as number
          const barW = row === 'naive' ? naiveBarW : reclaimBarW
          const isReclaim = row === 'reclaim'
          const insideLabel = barW > 90
          return (
            <g key={row}>
              <text
                x={LABEL_W - 12}
                y={y + BAR_H / 2 + 3}
                textAnchor="end"
                fontSize={9}
                letterSpacing="0.11em"
                fontWeight={isReclaim ? 700 : 400}
                fill={isReclaim ? 'var(--color-accent)' : 'var(--color-on-ink-muted)'}
              >
                {isReclaim ? 'RECLAIM' : 'RETRY EVERYTHING'}
              </text>
              <text x={LABEL_W - 12} y={y + BAR_H / 2 + 15} textAnchor="end" fontSize={9} fill="var(--color-on-ink-muted)">
                {isReclaim ? `${reclaimTouched} of ${totalCount} contacted` : `${naiveAttempts} attempts`}
              </text>

              <rect x={recoveredOrigin} y={y} width={RECOVERED_W} height={BAR_H} fill="var(--color-ink-line)" />
              <rect
                x={recoveredOrigin}
                y={y}
                width={Math.max(0.5, barW)}
                height={BAR_H}
                fill={isReclaim ? 'var(--color-accent)' : 'var(--color-accent-dim)'}
              />
              {isReclaim && barW > 5 && (
                <rect x={recoveredOrigin + barW - 5} y={y} width={5} height={BAR_H} fill="var(--color-accent-deep)" />
              )}
              <text
                x={insideLabel ? recoveredOrigin + barW - 8 : recoveredOrigin + barW + 8}
                y={y + BAR_H / 2 + 4}
                textAnchor={insideLabel ? 'end' : 'start'}
                fontSize={11}
                className="tnum"
                fill={insideLabel ? 'var(--color-ink)' : 'var(--color-on-ink)'}
              >
                {formatPaise(row === 'naive' ? naiveRecoveredPaise : reclaimRecoveredPaise)}
              </text>
            </g>
          )
        })}

        {/* Delta bracket */}
        <g transform={`translate(${recoveredOrigin},0)`}>
          <line x1={bracketX1} x2={bracketX1} y1={ROW_Y[0] + BAR_H} y2={BRACKET_Y} stroke="var(--color-on-ink-faint)" strokeDasharray="3 3" />
          <line x1={bracketX1} x2={bracketX1} y1={BRACKET_Y - 6} y2={BRACKET_Y} stroke="var(--color-on-ink-faint)" />
          <line x1={bracketX2} x2={bracketX2} y1={BRACKET_Y - 6} y2={BRACKET_Y} stroke="var(--color-on-ink-faint)" />
          <line x1={bracketX1} x2={bracketX2} y1={BRACKET_Y} y2={BRACKET_Y} stroke="var(--color-on-ink-faint)" />
          <text x={bracketLabelX} y={BRACKET_Y + 16} textAnchor={bracketAnchor} fontSize={11} fontWeight={700} fill={bracketColor}>
            {glyph === '=' ? 'no difference' : `${glyph} ${formatPaise(Math.abs(deltaPaise))}`}
          </text>
        </g>

        {/* ── Spend panel ── */}
        <text x={spendOrigin} y={72} fill="var(--color-on-ink-muted)" fontSize={9} letterSpacing="0.11em">
          WHAT IT COST
        </text>

        {(['naive', 'reclaim'] as const).map((row, i) => {
          const y = ROW_Y[i] as number
          const isReclaim = row === 'reclaim'
          return (
            <g key={row}>
              <rect x={spendOrigin} y={y} width={SPEND_W} height={BAR_H} fill="var(--color-ink-line)" />
              {isReclaim ? (
                <>
                  <rect x={spendOrigin} y={y} width={reclaimInterventionW} height={BAR_H} fill="var(--color-accent-dim)" />
                  <rect
                    x={spendOrigin + reclaimInterventionW + (reclaimInterventionW > 0 ? 1 : 0)}
                    y={y}
                    width={reclaimGatewayW}
                    height={BAR_H}
                    fill="var(--color-on-ink-faint)"
                  />
                </>
              ) : (
                <rect x={spendOrigin} y={y} width={Math.max(0.5, spendX(naiveSpendPaise))} height={BAR_H} fill="var(--color-on-ink-faint)" />
              )}
              <text x={spendOrigin + SPEND_W + 8} y={y + BAR_H / 2 + 4} fontSize={11} className="tnum" fill="var(--color-on-ink)">
                {formatPaise(row === 'naive' ? naiveSpendPaise : reclaimSpendPaise)}
              </text>
            </g>
          )
        })}

        <g transform={`translate(${spendOrigin},${ROW_Y[1] + BAR_H + 20})`} fontSize={9} fill="var(--color-on-ink-muted)">
          <rect x={0} y={-7} width={8} height={8} fill="var(--color-accent-dim)" />
          <text x={12} y={0}>intervention</text>
          <rect x={82} y={-7} width={8} height={8} fill="var(--color-on-ink-faint)" />
          <text x={94} y={0}>gateway fee, ₹2 per attempt</text>
        </g>
      </svg>
    </div>
  )
}
