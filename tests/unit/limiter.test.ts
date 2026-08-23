import { describe, it, expect } from 'vitest'
import { createLimiter } from '@/language/limiter'

describe('createLimiter', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const limiter = createLimiter({ concurrency: 2, minSpacingMs: 0 })
    let active = 0
    let maxActive = 0

    const tasks = Array.from({ length: 8 }, () =>
      limiter.run(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active--
      }),
    )
    await Promise.all(tasks)
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('enforces the minimum spacing between call starts', async () => {
    const limiter = createLimiter({ concurrency: 1, minSpacingMs: 50 })
    const starts: number[] = []
    const tasks = Array.from({ length: 3 }, () =>
      limiter.run(async () => {
        starts.push(Date.now())
      }),
    )
    await Promise.all(tasks)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(45) // small slack for timer jitter
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(45)
  })

  it('propagates a task error without deadlocking the limiter for later tasks', async () => {
    const limiter = createLimiter({ concurrency: 1, minSpacingMs: 0 })
    await expect(
      limiter.run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // The slot must have been released despite the throw.
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
  })
})
