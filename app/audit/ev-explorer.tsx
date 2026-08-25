/**
 * D10's EV explorer (BUILD_PLAN.md's D10 exit test: "Click any audit row and see
 * exactly why the argmax landed there, including which actions were excluded and
 * why. A DO_NOTHING row's rationale reads aloud without needing explanation.").
 * Plain divs, not a charting library — every component term is its own bar
 * segment, so the sign and relative size of `expectedGain` versus the cost terms
 * is visible without reading numbers.
 */
import type { EvBreakdownEntry } from './view-model'
import { DISALLOWED_REASON_LABELS } from './view-model'

const rupeeFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function formatMilliInr(m: number): string {
  const sign = m < 0 ? '-' : ''
  return `${sign}₹${rupeeFmt.format(Math.abs(m) / 100_000)}`
}

const ACTION_LABELS: Record<string, string> = {
  RETRY_NOW: 'Retry now',
  RETRY_LATER: 'Retry later',
  PAYMENT_LINK: 'Payment link',
  WHATSAPP_NUDGE: 'WhatsApp nudge',
  ESCALATE_HUMAN: 'Escalate to human',
  DO_NOTHING: 'Do nothing',
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
  const maxAbsEv = Math.max(1, ...breakdown.map((b) => Math.abs(b.ev)))

  return (
    <div>
      {rationale !== null && (
        <p className="mb-8 max-w-[70ch] text-body text-on-ink-soft">
          <span className="text-[0.625rem] tracking-[0.11em] text-accent uppercase">Rationale — </span>
          {rationale}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-t border-ink-line text-small">
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
                  <ComponentBars b={b} maxAbsEv={maxAbsEv} />
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

function ComponentBars({ b, maxAbsEv }: { b: EvBreakdownEntry; maxAbsEv: number }): React.JSX.Element {
  const segments: readonly { label: string; value: number; sign: 'pos' | 'neg' }[] = [
    { label: 'Expected gain', value: b.expectedGain, sign: 'pos' },
    { label: 'Intervention cost', value: b.interventionCost, sign: 'neg' },
    { label: 'Compute cost', value: b.computeCost, sign: 'neg' },
    { label: 'Risk penalty', value: b.riskPenalty, sign: 'neg' },
    { label: 'Contact fatigue', value: b.contactFatigueCost, sign: 'neg' },
  ]
  return (
    <div className="flex w-full max-w-[280px] flex-col gap-1" aria-hidden="true">
      {segments
        .filter((s) => s.value !== 0)
        .map((s) => {
          const widthPct = (Math.abs(s.value) / maxAbsEv) * 100
          return (
            <div key={s.label} className="flex items-center gap-2" title={`${s.label}: ${formatMilliInr(s.sign === 'neg' ? -s.value : s.value)}`}>
              <span className="w-[100px] shrink-0 truncate text-[0.625rem] text-on-ink-muted">{s.label}</span>
              <div className="h-1.5 flex-1 bg-ink-line">
                <div
                  className={s.sign === 'pos' ? 'h-full bg-pos' : 'h-full bg-neg'}
                  style={{ width: `${Math.max(2, widthPct)}%` }}
                />
              </div>
            </div>
          )
        })}
    </div>
  )
}
