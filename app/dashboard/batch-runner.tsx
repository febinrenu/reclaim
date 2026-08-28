'use client'

/**
 * The D9 batch runner: click "Run batch," watch the counters stream live over
 * SSE, and see every SYSTEM_SPEC.md §13 metric render once it finishes.
 * Localhost-only transport (BUILD_PLAN.md C5) — if `EventSource` errors before
 * ever opening (the dev-tunnel case, or a browser without SSE support), this
 * falls back to plain polling of the exact same JSON the stream sends, so the
 * two transports can never disagree (BUILD_PLAN.md's D9 exit test).
 */
import { useEffect, useRef, useState } from 'react'
import type { SerializedBatchReport } from '@/app/batch/serialize'
import { formatPaise, formatMilliInr, ACTION_LABELS } from '~/_viz/format'
import { BaselineChart } from './baseline-chart'

type ViewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'running'; readonly report: SerializedBatchReport; readonly transport: 'sse' | 'polling' }
  | { readonly kind: 'done'; readonly report: SerializedBatchReport; readonly transport: 'sse' | 'polling' }
  | { readonly kind: 'error'; readonly message: string }

export function BatchRunner(): React.JSX.Element {
  const [state, setState] = useState<ViewState>({ kind: 'idle' })
  const [total, setTotal] = useState(60)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    return () => {
      esRef.current?.close()
      if (pollRef.current !== null) clearInterval(pollRef.current)
    }
  }, [])

  function startPolling(batchId: string): void {
    esRef.current?.close()
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/batches/${batchId}`)
        if (!res.ok) throw new Error(`status ${res.status}`)
        const report = (await res.json()) as SerializedBatchReport
        const running = report.batch?.status === 'running'
        setState({ kind: running ? 'running' : 'done', report, transport: 'polling' })
        if (!running && pollRef.current !== null) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        if (pollRef.current !== null) clearInterval(pollRef.current)
      }
    }
    void tick()
    pollRef.current = setInterval(() => void tick(), 800)
  }

  function startStreaming(batchId: string): void {
    const es = new EventSource(`/api/batches/${batchId}/stream`)
    esRef.current = es
    let gotAnyMessage = false

    es.addEventListener('progress', (ev: MessageEvent<string>) => {
      gotAnyMessage = true
      const report = JSON.parse(ev.data) as SerializedBatchReport
      setState({ kind: 'running', report, transport: 'sse' })
    })
    es.addEventListener('done', (ev: MessageEvent<string>) => {
      gotAnyMessage = true
      const report = JSON.parse(ev.data) as SerializedBatchReport
      setState({ kind: 'done', report, transport: 'sse' })
      es.close()
    })
    es.onerror = () => {
      es.close()
      // Never got a single frame — SSE genuinely isn't reaching us (the tunnel
      // case, or an intermediary that buffers). Fall back rather than retry
      // a transport that isn't going to start working.
      if (!gotAnyMessage) startPolling(batchId)
    }
  }

  async function runBatch(): Promise<void> {
    setState({ kind: 'starting' })
    try {
      const res = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ total }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const body = (await res.json()) as { batchId: string }
      startStreaming(body.batchId)
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-3 text-small text-on-ink-soft">
          <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">Batch size</span>
          <input
            type="number"
            min={1}
            max={300}
            value={total}
            onChange={(e) => setTotal(Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
            disabled={state.kind === 'starting' || state.kind === 'running'}
            className="w-20 rounded border border-ink-line bg-ink-raised px-3 py-2 text-body tnum text-on-ink disabled:opacity-50"
          />
        </label>

        <button
          type="button"
          onClick={() => void runBatch()}
          disabled={state.kind === 'starting' || state.kind === 'running'}
          className="rounded-full bg-accent px-7 py-3 text-small font-bold text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {state.kind === 'starting'
            ? 'Starting…'
            : state.kind === 'running'
              ? 'Running…'
              : 'Run batch'}
        </button>

        {(state.kind === 'running' || state.kind === 'done') && (
          <span className="text-[0.625rem] tracking-[0.11em] text-accent-dim uppercase">
            Transport: {state.transport === 'sse' ? 'SSE' : 'Polling'}
          </span>
        )}
      </div>

      <div className="mt-10">
        {state.kind === 'idle' && (
          <p className="text-small text-on-ink-muted">
            No batch has been run yet. Choose a size and click Run batch — every event is a
            synthetic, signed `payment.failed` delivery through the real webhook path, always
            `dry_run` (BUILD_PLAN.md §6.5's B0–B5 bracket, computed on this exact batch).
          </p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className="text-small text-neg">
            Something went wrong: {state.message}
          </p>
        )}
        {(state.kind === 'running' || state.kind === 'done') && (
          <BatchReportView report={state.report} isRunning={state.kind === 'running'} />
        )}
      </div>
    </div>
  )
}

function ProgressBar({ done, failed, total }: { done: number; failed: number; total: number }): React.JSX.Element {
  const pct = total === 0 ? 0 : Math.min(100, ((done + failed) / total) * 100)
  return (
    <div>
      <div className="flex items-baseline justify-between text-small text-on-ink-soft">
        <span>
          {done + failed} / {total} settled
        </span>
        <span className="tnum">{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ink-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col justify-between bg-card p-6">
      <span className="text-[0.625rem] tracking-[0.11em] text-on-paper-muted uppercase">{label}</span>
      <div className="mt-8">
        <span className="display tnum text-[2.25rem] leading-none">{value}</span>
        {note !== undefined && <p className="mt-2 text-small text-on-paper-muted">{note}</p>}
      </div>
    </div>
  )
}

function BatchReportView({
  report,
  isRunning,
}: {
  report: SerializedBatchReport
  isRunning: boolean
}): React.JSX.Element {
  const b = report.batch
  const m = report.metrics
  const naive = report.naiveBaseline
  const ps = report.policySpend
  const dn = report.doNothing

  return (
    <div>
      {b !== null && <ProgressBar done={b.done} failed={b.failed} total={b.total} />}

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Revenue at risk" value={formatPaise(m.revenueAtRiskPaise)} note={`${m.count} decisions`} />
        {/* Labelled "model-implied" because it is: the outcome is drawn against the
            chosen action's own predicted pRecover, so it is a projection under this
            model, not a measurement. The measured number lives in docs/RESULTS.md,
            scored on oracle counterfactuals. */}
        <Tile
          label="Revenue recovered (model-implied)"
          value={formatPaise(m.revenueRecoveredPaise)}
          note={`${(m.recoveryRate * 100).toFixed(1)}% implied rate — projection, not measured`}
        />
        <Tile label="Escalated" value={String(m.escalatedCount)} note="routed to a human" />
        <Tile label="LLM spend" value={formatMilliInr(m.llmCostTotalMilli)} note="Groq, this batch" />
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <Tile label="Decision latency p50" value={`${m.latencyP50Ms}ms`} />
        <Tile label="Decision latency p95" value={`${m.latencyP95Ms}ms`} />
      </div>

      {isRunning && (
        <p className="mt-6 text-small text-on-ink-muted" aria-live="polite">
          Streaming — numbers above reflect settled decisions so far.
        </p>
      )}

      {!isRunning && (
        <>
          <div className="mt-14">
            <span className="eyebrow text-on-ink-muted">Baseline bracket</span>
            <h3 className="display mt-5 max-w-[36ch] text-sub">
              What retry-everything would have recovered, on this exact batch
            </h3>

            {m.revenueAtRiskPaise > 0 && (
              <div className="mt-8">
                <BaselineChart
                  revenueAtRiskPaise={m.revenueAtRiskPaise}
                  naiveRecoveredPaise={naive.revenueRecoveredPaise}
                  reclaimRecoveredPaise={m.revenueRecoveredPaise}
                  naiveAttempts={naive.count}
                  naiveGatewayFeePaise={naive.costPaise}
                  reclaimInterventionMilli={ps.interventionMilli}
                  reclaimGatewayFeePaise={ps.gatewayFeePaise}
                  reclaimTouched={ps.touched}
                  totalCount={m.count}
                />
              </div>
            )}

            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[560px] border-t border-ink-line text-small">
                <caption className="sr-only">Naive baseline versus this batch&apos;s policy</caption>
                <thead>
                  <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                    <th scope="col" className="py-3 text-left font-normal">
                      Policy
                    </th>
                    <th scope="col" className="py-3 text-right font-normal">
                      Recovered <span className="normal-case">(model-implied)</span>
                    </th>
                    <th scope="col" className="py-3 text-right font-normal">
                      Spend
                    </th>
                    <th scope="col" className="py-3 text-right font-normal">
                      Customers contacted
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-ink-line">
                    <th scope="row" className="py-3 text-left font-normal text-on-ink-soft">
                      Retry everything, immediately (naive)
                    </th>
                    <td className="py-3 text-right tnum">{formatPaise(naive.revenueRecoveredPaise)}</td>
                    <td className="py-3 text-right tnum">{formatPaise(naive.costPaise)}</td>
                    <td className="py-3 text-right tnum">{naive.count}</td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-3 text-left font-normal text-accent">
                      Reclaim (this batch)
                    </th>
                    <td className="py-3 text-right tnum text-accent">{formatPaise(m.revenueRecoveredPaise)}</td>
                    <td className="py-3 text-right tnum">
                      {formatMilliInr(ps.interventionMilli)} + {formatPaise(ps.gatewayFeePaise)} gateway
                    </td>
                    <td className="py-3 text-right tnum">{ps.touched}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-4 max-w-[70ch] space-y-3 text-small text-on-ink-muted">
              <p>
                <strong className="text-on-ink-soft">Spend and customers contacted are real</strong> —
                arithmetic on the actions <code>decide()</code> actually chose, no draw involved. The
                recovered column is not, and the difference matters.
              </p>
              <p>
                Each policy&apos;s outcome is drawn against{' '}
                <em>its own chosen action&apos;s predicted</em> <code>pRecover</code>, under the same
                seed per transaction. Common random numbers make that internally consistent, but they
                do not make it an experiment: an argmax-EV policy picks higher-probability actions
                essentially by construction, so Reclaim wins this comparison before the batch runs.
                The model is scoring itself against its own answer key.
              </p>
              <p>
                The measured version — every policy scored on per-action outcomes from the data
                generator that the model never saw — is in{' '}
                <code>docs/RESULTS.md</code>&apos;s &ldquo;Measured recovery, on oracle truth&rdquo;
                section. There Reclaim recovers <strong className="text-on-ink-soft">1.42×</strong>{' '}
                what retrying everything does, not 3×, and retrying everything comes out{' '}
                <em>behind doing nothing</em>.
              </p>
            </div>
          </div>

          <div className="mt-14 grid gap-10 lg:grid-cols-2">
            <div>
              <span className="eyebrow text-on-ink-muted">Actions chosen</span>
              <table className="mt-6 w-full border-t border-ink-line text-small">
                <caption className="sr-only">Count of decisions by chosen action</caption>
                <tbody>
                  {Object.entries(m.countByAction).map(([action, count]) => (
                    <tr key={action} className="border-b border-ink-line">
                      <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                        {ACTION_LABELS[action] ?? action}
                      </th>
                      <td className="py-2 text-right tnum font-bold">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <span className="eyebrow text-on-ink-muted">Do nothing, by reason</span>
              <table className="mt-6 w-full border-t border-ink-line text-small">
                <caption className="sr-only">DO_NOTHING decisions broken down by reason</caption>
                <tbody>
                  <tr className="border-b border-ink-line">
                    <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                      Negative expected value
                    </th>
                    <td className="py-2 text-right tnum font-bold">
                      {dn.negativeEvCount} ({formatPaise(dn.negativeEvValuePaise)})
                    </td>
                  </tr>
                  <tr className="border-b border-ink-line">
                    <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                      Risk gate override
                    </th>
                    <td className="py-2 text-right tnum font-bold">
                      {dn.riskGateOverrideCount} ({formatPaise(dn.riskGateOverrideValuePaise)})
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="py-2 text-left font-normal text-on-ink-soft">
                      Total
                    </th>
                    <td className="py-2 text-right tnum font-bold">
                      {dn.count} ({formatPaise(dn.valuePaise)})
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
