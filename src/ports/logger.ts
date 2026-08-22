/**
 * Structured logging. Objects, not interpolated strings.
 *
 * Two practical reasons beyond taste. Vercel retains runtime logs for one hour, so
 * anything worth keeping goes to Postgres and the log is for the live session only.
 * And during the demo-recording phase, a trail you can filter by eventId is the
 * difference between finding a problem and guessing at it.
 */
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(fields: LogFields, msg: string): void
  info(fields: LogFields, msg: string): void
  warn(fields: LogFields, msg: string): void
  error(fields: LogFields, msg: string): void
  /** Returns a logger that merges these fields into every subsequent record. */
  child(fields: LogFields): Logger
}
