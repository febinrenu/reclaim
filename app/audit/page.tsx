import Link from 'next/link'
import { getDeps } from '@/server/di'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import { AuditRow, type AuditRowData } from './audit-row'
import { CsvExportButton } from './csv-export'
import { parseEvBreakdown, parseAmountPaise } from './view-model'
import { pickStoryRow } from './story-example'
import { EvExplorer } from './ev-explorer'
import { ACTION_LABELS } from '~/_viz/format'

export const dynamic = 'force-dynamic'

const LIMIT = 100

/*
 * D10's audit table (BUILD_PLAN.md's D10 row): filters, execution-mode badges,
 * and — per row — the full EV explorer showing exactly why the argmax landed
 * where it did, including every excluded action and its reason.
 *
 * A Server Component: filters are plain GET query params, so the filtered view
 * is a real URL (shareable, back-button-safe) rather than client state, and no
 * client JS is needed just to filter a table.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const params = await searchParams
  const actionFilter = typeof params.action === 'string' && params.action !== '' ? params.action : undefined
  const modeFilter =
    typeof params.mode === 'string' && (params.mode === 'live' || params.mode === 'dry_run') ? params.mode : undefined

  const deps = await getDeps()
  const [rows, facets, anyRowAtAll] = await Promise.all([
    recoveryAuditRepo.listRecent(deps.sql, {
      limit: LIMIT,
      ...(actionFilter !== undefined ? { chosenAction: actionFilter } : {}),
      ...(modeFilter !== undefined ? { executionMode: modeFilter } : {}),
    }),
    recoveryAuditRepo.listDistinctFacets(deps.sql),
    // Unfiltered, limit 1: distinguishes "no data at all" from "zero results
    // after this filter" — the two different empty states BUILD_PLAN.md §3.8 asks for.
    recoveryAuditRepo.listRecent(deps.sql, { limit: 1 }),
  ])

  const hasAnyDataAtAll = anyRowAtAll.length > 0
  const hasFiltersApplied = actionFilter !== undefined || modeFilter !== undefined

  // The pinned story example draws from the unfiltered set (up to LIMIT recent
  // rows) regardless of any action/mode filter applied to the table below — the
  // "how a decision gets made" moment should stay stable while a visitor filters.
  const storyRows: readonly AuditRowData[] = (hasFiltersApplied ? await recoveryAuditRepo.listRecent(deps.sql, { limit: LIMIT }) : rows).map(
    (r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      transactionId: r.transactionId,
      scenario: r.scenario,
      chosenAction: r.chosenAction,
      executionMode: r.executionMode,
      outcome: r.outcome,
      amountPaise: parseAmountPaise(r.decisionInput),
      evMilli: r.evMilli,
      upliftMilli: r.upliftMilli,
      rationale: r.rationale,
      breakdown: parseEvBreakdown(r.evBreakdown),
    }),
  )
  const story = pickStoryRow(storyRows)

  const rowData: readonly AuditRowData[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    transactionId: r.transactionId,
    scenario: r.scenario,
    chosenAction: r.chosenAction,
    executionMode: r.executionMode,
    outcome: r.outcome,
    amountPaise: parseAmountPaise(r.decisionInput),
    evMilli: r.evMilli,
    upliftMilli: r.upliftMilli,
    rationale: r.rationale,
    breakdown: parseEvBreakdown(r.evBreakdown),
  }))

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
            <span className="text-accent">Audit</span>
            <Link href="/model" className="hover:text-accent">
              Model
            </Link>
            <Link href="/queue" className="hover:text-accent">
              Queue
            </Link>
            <Link href="/operator" className="hover:text-accent">
              Operator
            </Link>
            <Link href="/simulate" className="hover:text-accent">
              Simulate
            </Link>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">Audit ledger</span>
          <h1 className="display mt-7 max-w-[24ch] text-section">
            Every decision, and <span className="text-on-ink-dim">exactly why</span> the argmax
            landed there
          </h1>

          {story !== null && (
            <div className="mt-10 bg-ink-raised p-8">
              <span className="text-[0.625rem] tracking-[0.11em] text-accent uppercase">
                How a decision gets made
              </span>
              <p className="mt-4 max-w-[70ch] text-small text-on-ink-soft">
                {story.higherProbabilityAction !== null ? (
                  <>
                    <span className="text-accent">
                      {ACTION_LABELS[story.higherProbabilityAction.action] ?? story.higherProbabilityAction.action}
                    </span>{' '}
                    had a higher predicted recovery probability (
                    {(story.higherProbabilityAction.pRecover * 100).toFixed(1)}%) than{' '}
                    <span className="text-accent">{ACTION_LABELS[story.row.chosenAction] ?? story.row.chosenAction}</span>,
                    the action actually chosen. Reclaim picked it anyway, because probability alone
                    was never the question — priced in cost and risk, it was worth more. This is one
                    real row, found in this ledger, not a constructed example.
                  </>
                ) : (
                  <>
                    One real row from this ledger, in full — every action considered, including the
                    ones excluded and why.
                  </>
                )}
              </p>
              <div className="mt-8">
                <EvExplorer breakdown={story.row.breakdown ?? []} chosenAction={story.row.chosenAction} rationale={story.row.rationale} />
              </div>
            </div>
          )}

          <form method="GET" className="mt-10 flex flex-wrap items-end gap-6">
            <label className="flex flex-col gap-2 text-small">
              <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">Action</span>
              <select
                name="action"
                defaultValue={actionFilter ?? ''}
                className="rounded border border-ink-line bg-ink-raised px-3 py-2 text-on-ink"
              >
                <option value="">All actions</option>
                {facets.actions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-2 text-small">
              <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                Execution mode
              </span>
              <select
                name="mode"
                defaultValue={modeFilter ?? ''}
                className="rounded border border-ink-line bg-ink-raised px-3 py-2 text-on-ink"
              >
                <option value="">All modes</option>
                {facets.executionModes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              className="rounded-full bg-accent px-6 py-2 text-small font-bold text-ink hover:opacity-90"
            >
              Filter
            </button>

            {hasFiltersApplied && (
              <Link
                href="/audit"
                className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase hover:text-accent"
              >
                Clear filters
              </Link>
            )}

            <div className="ml-auto">
              <CsvExportButton rows={rowData} />
            </div>
          </form>

          <div className="mt-10">
            {!hasAnyDataAtAll ? (
              <EmptyState />
            ) : rowData.length === 0 ? (
              <ZeroResultsState />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[840px] border-t border-ink-line text-small">
                  <caption className="sr-only">Recovery decisions, most recent first</caption>
                  <thead>
                    <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Time
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Transaction
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Chosen action
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Mode
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Outcome
                      </th>
                      <th scope="col" className="py-3 pr-4 text-right font-normal">
                        Amount
                      </th>
                      <th scope="col" className="py-3 text-right font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {rowData.map((row) => (
                      <AuditRow key={row.id} row={row} />
                    ))}
                  </tbody>
                </table>
                <p className="mt-4 text-[0.625rem] text-on-ink-muted">
                  Showing the most recent {rowData.length} decision{rowData.length === 1 ? '' : 's'}
                  {hasFiltersApplied ? ', filtered' : ''}.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="border-t border-ink-line py-16 text-center">
      <p className="text-body text-on-ink-soft">No decisions recorded yet.</p>
      <p className="mt-3 text-small text-on-ink-muted">
        Run a batch from the{' '}
        <Link href="/dashboard" className="text-accent hover:opacity-80">
          dashboard
        </Link>{' '}
        to populate the audit ledger.
      </p>
    </div>
  )
}

function ZeroResultsState(): React.JSX.Element {
  return (
    <div className="border-t border-ink-line py-16 text-center">
      <p className="text-body text-on-ink-soft">No decisions match this filter.</p>
      <p className="mt-3 text-small text-on-ink-muted">
        <Link href="/audit" className="text-accent hover:opacity-80">
          Clear filters
        </Link>{' '}
        to see every decision.
      </p>
    </div>
  )
}
