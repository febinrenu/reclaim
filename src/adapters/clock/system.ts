import type { Clock } from '@/domain/clock'

/**
 * The real clock. Lives here rather than in src/domain because reading the host
 * clock is I/O, and the domain is required to be pure so that decide() can be
 * replayed deterministically. Constructed in the container only.
 */
export const systemClock: Clock = {
  nowMs: () => Date.now(),
}
