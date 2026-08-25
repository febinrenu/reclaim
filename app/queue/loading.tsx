export default function QueueLoading(): React.JSX.Element {
  return (
    <main id="main">
      <section className="bg-ink px-gutter pt-8 pb-band">
        <div className="mx-auto max-w-[1240px] animate-pulse">
          <div className="h-4 w-32 rounded-full bg-ink-line" />
          <div className="mt-9 h-12 w-2/3 rounded bg-ink-line" />
          <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-24 rounded bg-ink-line" />
            ))}
          </div>
          <div className="mt-14 space-y-3" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-10 w-full rounded bg-ink-line" />
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
