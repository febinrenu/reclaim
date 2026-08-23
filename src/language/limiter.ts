/**
 * The limiter (BUILD_PLAN.md §5.8 point 4): concurrency 2, 350ms minimum spacing
 * between calls. Retries with jitter, `Retry-After`, and the 6-second timeout
 * live inside the Groq adapter itself (src/adapters/llm/groq.ts) — this module
 * is purely about how many calls run at once and how close together they start,
 * which is a property of the caller, not of any one call.
 *
 * A simple counting semaphore plus a shared "earliest next start" timestamp is
 * enough here: this project makes at most a couple of dozen calls per batch
 * (BUILD_PLAN.md §5.8 point 1's 8% sample, capped at 24), never a queue deep
 * enough to need anything more sophisticated.
 */
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>
}

export function createLimiter(opts: { readonly concurrency: number; readonly minSpacingMs: number }): Limiter {
  let active = 0
  let earliestNextStart = 0
  const queue: (() => void)[] = []

  function next(): void {
    if (active >= opts.concurrency) return
    const resume = queue.shift()
    if (resume === undefined) return
    active++
    resume()
  }

  async function acquire(): Promise<void> {
    await new Promise<void>((resolve) => {
      queue.push(resolve)
      next()
    })
    const waitMs = earliestNextStart - Date.now()
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    earliestNextStart = Date.now() + opts.minSpacingMs
  }

  function release(): void {
    active--
    next()
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
