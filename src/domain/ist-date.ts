/**
 * IST is a fixed UTC+5:30 offset — no DST, no tz database lookup needed — so
 * "today" for an India-facing quiet-hours or daily-budget rule can be computed
 * with plain integer arithmetic on `nowMs`, pure and independent of the host
 * machine's own timezone (`new Date().getHours()` would silently be wrong on a
 * CI runner or a US-hosted deployment).
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000

/** The hour-of-day (0-23) in IST for the instant `nowMs`. */
export function istHourOfDay(nowMs: number): number {
  const istMs = nowMs + IST_OFFSET_MS
  const msIntoDay = ((istMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY
  return Math.floor(msIntoDay / MS_PER_HOUR)
}

/**
 * Howard Hinnant's `civil_from_days`: days-since-epoch to a proleptic
 * Gregorian (y, m, d), in pure integer arithmetic. No `Date` object — this
 * file is `src/domain`, where an ESLint boundary rule forbids `new Date(...)`
 * precisely so time never enters through anything but an injected `nowMs`,
 * and calendar math is exactly the kind of thing that would otherwise tempt
 * one in "just to format a date".
 */
function civilFromDays(daysSinceEpoch: number): readonly [year: number, month: number, day: number] {
  const z = daysSinceEpoch + 719_468
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097)
  const doe = z - era * 146_097 // day-of-era, [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365) // year-of-era, [0, 399]
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)) // day-of-year, [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153) // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1 // [1, 31]
  const month = mp + (mp < 10 ? 3 : -9) // [1, 12]
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0)
  return [year, month, day]
}

/** `YYYY-MM-DD` in IST for the instant `nowMs` — a stable key for "today", used
 * to scope a daily counter (escalation budget) without depending on the host's
 * own timezone. */
export function istCalendarDate(nowMs: number): string {
  const istMs = nowMs + IST_OFFSET_MS
  const daysSinceEpoch = Math.floor(istMs / MS_PER_DAY)
  const [year, month, day] = civilFromDays(daysSinceEpoch)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
