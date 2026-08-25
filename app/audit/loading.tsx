/**
 * BUILD_PLAN.md §3.8: "Every view needs empty, loading skeleton, error, and
 * zero-results-after-filter." Next's `loading.tsx` convention renders this
 * automatically while the Server Component above is awaiting its queries.
 */
export default function AuditLoading(): React.JSX.Element {
  return (
    <main id="main">
      <section className="bg-ink px-gutter pt-8 pb-band">
        <div className="mx-auto max-w-[1240px] animate-pulse">
          <div className="h-4 w-32 rounded-full bg-ink-line" />
          <div className="mt-9 h-12 w-2/3 rounded bg-ink-line" />
          <div className="mt-10 flex gap-6">
            <div className="h-10 w-40 rounded bg-ink-line" />
            <div className="h-10 w-40 rounded bg-ink-line" />
          </div>
          <div className="mt-10 space-y-3" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-10 w-full rounded bg-ink-line" />
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
