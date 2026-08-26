/**
 * D10's EV explorer (BUILD_PLAN.md's D10 exit test: "Click any audit row and see
 * exactly why the argmax landed there, including which actions were excluded and
 * why. A DO_NOTHING row's rationale reads aloud without needing explanation.").
 *
 * Each row renders as an inline-SVG waterfall — start at zero, step right by the
 * expected gain, step left by each nonzero cost term, land on net EV — because
 * that running subtraction is literally what `decide()` computes (BUILD_PLAN.md
 * §11), and a chart's whole job is making that arithmetic visible instead of
 * requiring the reader to do it. A previous version drew five same-scale bars
 * instead: real bug, found by reading the math rather than assumed correct — the
 * bars were scaled against the max |net EV| across actions, but a gross component
 * like `expectedGain` routinely exceeds that when an action's net is close to
 * zero, so the bar's width exceeded 100% and overflowed its track. This version's
 * domain spans every running-total step across every action, so nothing can
 * overflow by construction.
 */
import type { EvBreakdownEntry } from './view-model'
import { DISALLOWED_REASON_LABELS } from './view-model'
import { formatMilliInr, formatSigned, ACTION_LABELS } from '~/_viz/format'
import { linear } from '~/_viz/scale'

/** Always spans zero, so the zero-rule and every step are guaranteed on-domain. */
function evDomain(breakdown: readonly EvBreakdownEntry[]): { lo: number; hi: number } {
  let lo = 0
  let hi = 0
  for (const b of breakdown) {
    let run = b.expectedGain
    hi = Math.max(hi, run)
    lo = Math.min(lo, run)
    for (const cost of [b.interventionCost, b.computeCost, b.riskPenalty, b.contactFatigueCost]) {
      run -= cost
      hi = Math.max(hi, run)
      lo = Math.min(lo, run)
    }
    hi = Math.max(hi, b.ev)
    lo = Math.min(lo, b.ev)
  }
  return { lo, hi }
}

export function EvExplorer({
  breakdown,
  chosenAction,
  rationale,
}: {
  breakdown: readonly EvBreakdownEntry[]
  chosenAction: string
  rationale: string | null
}): React.JSX.Element {
  const domain = evDomain(breakdown)

  return (
    <div>
      {rationale !== null && (
        <p className="mb-8 max-w-[70ch] text-body text-on-ink-soft">
          <span className="text-[0.625rem] tracking-[0.11em] text-accent uppercase">Rationale — </span>
          {rationale}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] border-t border-ink-line text-small">
          <caption className="sr-only">
            Expected-value breakdown for every action considered, including disallowed ones
          </caption>
          <thead>
            <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
              <th scope="col" className="py-3 text-left font-normal">
                Action
              </th>
              <th scope="col" className="py-3 text-left font-normal">
                P(recover)
              </th>
              <th scope="col" className="py-3 text-left font-normal">
                Components
              </th>
              <th scope="col" className="py-3 text-right font-normal">
                Net EV
              </th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((b) => (
              <tr
                key={b.action}
                className={`border-b border-ink-line ${b.allowed ? '' : 'opacity-40'}`}
              >
                <th scope="row" className="py-4 pr-4 text-left align-top font-normal">
                  <div className="flex items-center gap-2">
                    {b.action === chosenAction && (
                      <span aria-hidden="true" className="text-accent">
                        ▸
                      </span>
                    )}
                    <span className={b.action === chosenAction ? 'font-bold text-accent' : 'text-on-ink-soft'}>
                      {ACTION_LABELS[b.action] ?? b.action}
                    </span>
                  </div>
                  {!b.allowed && b.disallowedReason !== null && (
                    <p className="mt-1 max-w-[24ch] text-[0.625rem] text-on-ink-muted">
                      Excluded — {DISALLOWED_REASON_LABELS[b.disallowedReason] ?? b.disallowedReason}
                    </p>
                  )}
                </th>
                <td className="py-4 pr-4 align-top tnum text-on-ink-soft">
                  {(b.pRecover * 100).toFixed(1)}%
                </td>
                <td className="py-4 pr-4 align-top">
                  <Waterfall b={b} domain={domain} isChosen={b.action === chosenAction} />
                </td>
                <td className="py-4 text-right align-top tnum font-bold">
                  <span className={b.ev >= 0 ? 'text-pos' : 'text-neg'}>{formatMilliInr(b.ev)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const WATERFALL_W = 340
const WATERFALL_H = 34

interface WaterfallStep {
  readonly label: string
  readonly delta: number // signed: positive for the gain, negative for each cost
}

function Waterfall({
  b,
  domain,
  isChosen,
}: {
  b: EvBreakdownEntry
  domain: { lo: number; hi: number }
  isChosen: boolean
}): React.JSX.Element {
  const wx = linear(domain.lo, domain.hi, 0, WATERFALL_W)

  const steps: readonly WaterfallStep[] = [
    { label: 'Expected gain', delta: b.expectedGain },
    ...(b.interventionCost !== 0 ? [{ label: 'Intervention cost', delta: -b.interventionCost }] : []),
    ...(b.computeCost !== 0 ? [{ label: 'Compute cost', delta: -b.computeCost }] : []),
    ...(b.riskPenalty !== 0 ? [{ label: 'Risk penalty', delta: -b.riskPenalty }] : []),
    ...(b.contactFatigueCost !== 0 ? [{ label: 'Contact fatigue', delta: -b.contactFatigueCost }] : []),
  ]

  let run = 0
  const bars = steps.map((s) => {
    const from = run
    run += s.delta
    return { x1: wx(Math.min(from, run)), x2: wx(Math.max(from, run)), isGain: s.delta > 0 }
  })

  const zeroX = wx(0)
  const netX = wx(b.ev)
  const netColor = isChosen ? 'var(--color-accent)' : 'var(--color-on-ink-muted)'

  const ariaLabel = `${ACTION_LABELS[b.action] ?? b.action}: ${steps
    .map((s) => `${s.label} ${formatSigned(s.delta, formatMilliInr)}`)
    .join(', ')}, net expected value ${formatMilliInr(b.ev)}`

  return (
    <div className="w-full max-w-[360px]">
      <svg viewBox={`0 0 ${WATERFALL_W} ${WATERFALL_H}`} role="img" aria-label={ariaLabel} className="w-full">
        <line x1={zeroX} x2={zeroX} y1={2} y2={26} stroke="var(--color-ink-line)" strokeWidth={1} />
        {bars.map((bar, i) => {
          const width = Math.max(1, Math.abs(bar.x2 - bar.x1) - (bars.length > 1 ? 1 : 0))
          return (
            <rect
              key={steps[i]?.label ?? i}
              x={Math.min(bar.x1, bar.x2)}
              y={6}
              width={width}
              height={14}
              fill={bar.isGain ? 'var(--color-pos-bright)' : 'var(--color-neg-bright)'}
            />
          )
        })}
        <line x1={netX} x2={netX} y1={2} y2={26} stroke={netColor} strokeWidth={2} />
        <path d={`M ${netX - 4},0 L ${netX + 4},0 L ${netX},5 Z`} fill={netColor} />
      </svg>

      {/* The same arithmetic as text — never SVG-only (BUILD_PLAN.md §3.8) — and
          replaces the previous version's `title` tooltips, which were invisible
          to a screen reader and to anyone not hovering a mouse. */}
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[0.625rem] tnum">
        {steps.map((s) => (
          <span key={s.label} className={s.delta >= 0 ? 'text-pos' : 'text-neg'}>
            {formatSigned(s.delta, formatMilliInr)}
          </span>
        ))}
        <span className={isChosen ? 'font-bold text-accent' : 'text-on-ink-muted'}>
          = {formatMilliInr(b.ev)}
        </span>
      </p>
    </div>
  )
}
