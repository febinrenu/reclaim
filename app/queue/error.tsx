'use client'

export default function QueueError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.JSX.Element {
  return (
    <main id="main">
      <section className="bg-ink px-gutter pt-8 pb-band">
        <div className="mx-auto max-w-[1240px]">
          <span className="eyebrow text-neg">Error</span>
          <h1 className="display mt-7 max-w-[24ch] text-section">Could not load the queue</h1>
          <p className="mt-6 max-w-[62ch] text-body text-on-ink-soft">{error.message}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-8 rounded-full bg-accent px-7 py-3 text-small font-bold text-ink hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </section>
    </main>
  )
}
