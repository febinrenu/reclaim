'use client'

/**
 * D12's simulator page (BUILD_PLAN.md §1.4 point 1): pick a stored batch,
 * adjust the intervention cost table or the risk threshold, and see the
 * action-distribution diff — computed entirely offline, no audit rows
 * written, no executor called. `/api/simulate` recomputes the baseline every
 * time rather than trusting a cached number, so the "reproduces the baseline
 * byte for byte" claim is checked live, not just in a test.
 */
import { useEffect, useState } from 'react'
import type { SerializedSimulationResult } from '@/app/simulate/serialize'
import { ACTION_LABELS, ACTION_ORDER } from '~/_viz/format'
import { PolicyShiftChart, EvDeltaChart } from './policy-shift-chart'

interface BatchOption {
  readonly id: string
  readonly total: number
  readonly startedAt: string
}

type ViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'result'; readonly result: SerializedSimulationResult }
  | { readonly kind: 'error'; readonly message: string }

export function Simulator(): React.JSX.Element {
  const [batches, setBatches] = useState<readonly BatchOption[] | null>(null)
  const [selectedBatchId, setSelectedBatchId] = useState<string>('')
  const [nudgeCost, setNudgeCost] = useState(0.35)
  const [riskThreshold, setRiskThreshold] = useState(0.5)
  const [state, setState] = useState<ViewState>({ kind: 'idle' })

  useEffect(() => {
    fetch('/api/batches')
      .then((res) => res.json() as Promise<{ batches: BatchOption[] }>)
      .then((body) => {
        setBatches(body.batches)
        if (body.batches.length > 0) setSelectedBatchId(body.batches[0]?.id ?? '')
      })
      .catch((err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }))
  }, [])

  async function runSimulation(): Promise<void> {
    if (selectedBatchId === '') return
    setState({ kind: 'loading' })
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batchId: selectedBatchId,
          interventionCostRupees: { WHATSAPP_NUDGE: nudgeCost },
          riskThreshold,
        }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const result = (await res.json()) as SerializedSimulationResult
      setState({ kind: 'result', result })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  if (batches === null) {
    return <p className="text-small text-on-ink-muted">Loading batches…</p>
  }

  if (batches.length === 0) {
    return (
      <p className="text-small text-on-ink-muted">
        No completed batches yet. Run one from the dashboard first, then come back here to simulate
        a different policy against it.
      </p>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-2 text-small">
          <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">Baseline batch</span>
          <select
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="w-64 rounded border border-ink-line bg-ink-raised px-3 py-2 text-on-ink"
          >
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {new Date(b.startedAt).toLocaleString('en-IN')} · {b.total} events
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-small">
          <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
            WhatsApp nudge cost (₹)
          </span>
          <input
            type="number"
            step={0.01}
            min={0}
            value={nudgeCost}
            onChange={(e) => setNudgeCost(Number(e.target.value))}
            className="w-32 rounded border border-ink-line bg-ink-raised px-3 py-2 text-on-ink tnum"
          />
        </label>

        <label className="flex flex-col gap-2 text-small">
          <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">Risk threshold</span>
          <input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={riskThreshold}
            onChange={(e) => setRiskThreshold(Number(e.target.value))}
            className="w-32 rounded border border-ink-line bg-ink-raised px-3 py-2 text-on-ink tnum"
          />
        </label>

        <button
          type="button"
          onClick={() => void runSimulation()}
          disabled={state.kind === 'loading'}
          className="rounded-full bg-accent px-7 py-3 text-small font-bold text-ink hover:opacity-90 disabled:opacity-50"
        >
          {state.kind === 'loading' ? 'Simulating…' : 'Run simulation'}
        </button>
      </div>

      <div className="mt-10">
        {state.kind === 'idle' && (
          <p className="text-small text-on-ink-muted">
            Pick a batch and adjust a policy parameter, then run the simulation. Nothing here writes
            to the audit ledger or calls a payments client — this is pure re-computation over stored
            decisions.
          </p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className="text-small text-neg">
            Something went wrong: {state.message}
          </p>
        )}
        {state.kind === 'result' && <DiffTable result={state.result} />}
      </div>
    </div>
  )
}

function DiffTable({ result }: { result: SerializedSimulationResult }): React.JSX.Element {
  const { baseline, simulated } = result
  const actions = ACTION_ORDER.filter(
    (a) => (baseline.countByAction[a] ?? 0) > 0 || (simulated.countByAction[a] ?? 0) > 0,
  )
  const distributionUnchanged = actions.every((a) => (baseline.countByAction[a] ?? 0) === (simulated.countByAction[a] ?? 0))

  return (
    <div>
      {result.unparsedCount > 0 && (
        <p className="mb-6 text-small text-on-ink-muted">
          {result.unparsedCount} of {result.totalRows} stored rows could not be parsed back into a
          decision input and were skipped.
        </p>
      )}

      {actions.length > 0 && (
        <div className="mb-8">
          <PolicyShiftChart actions={actions} baselineCounts={baseline.countByAction} simulatedCounts={simulated.countByAction} />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-t border-ink-line text-small">
          <caption className="sr-only">Action distribution, baseline versus simulated policy</caption>
          <thead>
            <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
              <th scope="col" className="py-3 text-left font-normal">
                Action
              </th>
              <th scope="col" className="py-3 text-right font-normal">
                Baseline
              </th>
              <th scope="col" className="py-3 text-right font-normal">
                Simulated
              </th>
              <th scope="col" className="py-3 text-right font-normal">
                Δ
              </th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const b = baseline.countByAction[a] ?? 0
              const s = simulated.countByAction[a] ?? 0
              const delta = s - b
              return (
                <tr key={a} className="border-b border-ink-line">
                  <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                    {ACTION_LABELS[a] ?? a}
                  </th>
                  <td className="py-2 text-right tnum">{b}</td>
                  <td className="py-2 text-right tnum">{s}</td>
                  <td className={`py-2 text-right tnum font-bold ${delta > 0 ? 'text-pos' : delta < 0 ? 'text-neg' : 'text-on-ink-muted'}`}>
                    {delta > 0 ? '+' : ''}
                    {delta}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8">
        <span className="eyebrow text-on-ink-muted">EV difference</span>
        <div className="mt-4 bg-ink-raised p-6">
          <EvDeltaChart baselineEvMilli={baseline.evMilliTotal} simulatedEvMilli={simulated.evMilliTotal} />
        </div>
      </div>

      <p className="mt-6 text-small text-on-ink-muted">
        {distributionUnchanged
          ? 'The action distribution did not change under this policy — a real, checkable outcome when the parameter change is too small to flip any argmax comparison, not a bug in the simulator.'
          : `The action distribution changed for ${actions.filter((a) => (baseline.countByAction[a] ?? 0) !== (simulated.countByAction[a] ?? 0)).length} action(s).`}
      </p>
    </div>
  )
}
