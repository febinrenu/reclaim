import Link from 'next/link'
import { getDeps } from '@/server/di'
import * as jobQueueRepo from '@/repositories/job-queue.repo'

export const dynamic = 'force-dynamic'

const LIMIT = 100
const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  claimed: 'Claimed',
  done: 'Done',
  failed: 'Failed',
}

/*
 * D10's queue page: a read-only snapshot of `job_queue` — status tiles plus the
 * most recent jobs. Never claims or mutates anything; that stays exclusively in
 * `drainOnce` (src/app/worker/drain.ts), so opening this page can never itself
 * change queue state.
 */
export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const params = await searchParams
  const statusFilter =
    typeof params.status === 'string' && ['pending', 'claimed', 'done', 'failed'].includes(params.status)
      ? (params.status as 'pending' | 'claimed' | 'done' | 'failed')
      : undefined

  const deps = await getDeps()
  const [counts, jobs, anyJobAtAll] = await Promise.all([
    jobQueueRepo.countByStatus(deps.sql),
    jobQueueRepo.listRecent(deps.sql, { limit: LIMIT, ...(statusFilter !== undefined ? { status: statusFilter } : {}) }),
    jobQueueRepo.listRecent(deps.sql, { limit: 1 }),
  ])

  const hasAnyDataAtAll = anyJobAtAll.length > 0

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
            <Link href="/model" className="hover:text-accent">
              Model
            </Link>
            <span className="text-accent">Queue</span>
            <Link href="/simulate" className="hover:text-accent">
              Simulate
            </Link>
          </div>
        </nav>

        <div className="mx-auto mt-14 max-w-[1240px]">
          <span className="eyebrow text-accent">Job queue</span>
          <h1 className="display mt-7 max-w-[22ch] text-section">
            What the worker has <span className="text-on-ink-dim">claimed, settled, or lost</span>
          </h1>

          <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {(['pending', 'claimed', 'done', 'failed'] as const).map((status) => (
              <Link
                key={status}
                href={status === statusFilter ? '/queue' : `/queue?status=${status}`}
                className="flex flex-col justify-between border p-6 transition-colors"
                style={{
                  borderColor: status === statusFilter ? 'var(--color-accent)' : 'var(--color-ink-line)',
                }}
              >
                <span className="text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                  {STATUS_LABELS[status]}
                </span>
                <span className="display mt-6 text-[2.25rem] tnum leading-none">{counts[status]}</span>
              </Link>
            ))}
          </div>

          <div className="mt-14">
            {!hasAnyDataAtAll ? (
              <EmptyState />
            ) : jobs.length === 0 ? (
              <ZeroResultsState />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-t border-ink-line text-small">
                  <caption className="sr-only">Most recent queue jobs</caption>
                  <thead>
                    <tr className="border-b border-ink-line text-[0.625rem] tracking-[0.11em] text-on-ink-muted uppercase">
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Updated
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Kind
                      </th>
                      <th scope="col" className="py-3 pr-4 text-left font-normal">
                        Status
                      </th>
                      <th scope="col" className="py-3 pr-4 text-right font-normal">
                        Attempts
                      </th>
                      <th scope="col" className="py-3 text-left font-normal">
                        Last error
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr key={job.id} className="border-b border-ink-line">
                        <td className="py-3 pr-4 text-on-ink-muted">
                          {job.availableAt.toLocaleTimeString('en-IN', { hour12: false })}
                        </td>
                        <td className="py-3 pr-4 font-mono text-on-ink-soft">{job.kind}</td>
                        <td className="py-3 pr-4">
                          <span
                            className="rounded-full px-2 py-0.5 text-[0.625rem] tracking-[0.08em] uppercase"
                            style={{
                              backgroundColor:
                                job.status === 'failed'
                                  ? 'var(--color-neg)'
                                  : job.status === 'done'
                                    ? 'var(--color-pos)'
                                    : 'var(--color-ink-line)',
                              color: job.status === 'pending' || job.status === 'claimed' ? 'var(--color-on-ink-soft)' : 'var(--color-on-ink)',
                            }}
                          >
                            {job.status}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right tnum">{job.attempts}</td>
                        <td className="max-w-[36ch] truncate py-3 text-on-ink-muted">{job.lastError ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-4 text-[0.625rem] text-on-ink-muted">
                  Showing the most recent {jobs.length} job{jobs.length === 1 ? '' : 's'}
                  {statusFilter !== undefined ? `, status = ${statusFilter}` : ''}.
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
      <p className="text-body text-on-ink-soft">No jobs have ever been enqueued.</p>
      <p className="mt-3 text-small text-on-ink-muted">
        Run a batch from the{' '}
        <Link href="/dashboard" className="text-accent hover:opacity-80">
          dashboard
        </Link>{' '}
        to populate the queue.
      </p>
    </div>
  )
}

function ZeroResultsState(): React.JSX.Element {
  return (
    <div className="border-t border-ink-line py-16 text-center">
      <p className="text-body text-on-ink-soft">No jobs in this status.</p>
      <p className="mt-3 text-small text-on-ink-muted">
        <Link href="/queue" className="text-accent hover:opacity-80">
          Clear filter
        </Link>{' '}
        to see every job.
      </p>
    </div>
  )
}
