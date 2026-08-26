/**
 * Pure scale/tick math shared by every inline-SVG chart in this app (see
 * `app/model/calibration-chart.tsx` for the established house pattern: module-local
 * layout constants, no charting library — BUILD_PLAN.md §3.4 D10 row). Nothing here
 * touches React; every chart component composes these with its own layout.
 */

/** Linear map from a data domain to a pixel range. Degenerate domains (d0 === d1 —
 * a chart with a single data point, or an all-zero batch) must never produce NaN in
 * an SVG attribute, which silently blanks the element with no visible error. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  if (d0 === d1) return () => r0
  const scale = (r1 - r0) / (d1 - d0)
  return (v: number) => r0 + (v - d0) * scale
}

/** Rounds up to the next "nice" 1/2/5 × 10^k value at or above v, so axis ticks land
 * on round numbers instead of whatever the data happened to produce. v <= 0 returns
 * a small positive default rather than 0, so a scale built from it is never degenerate. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const fraction = v / base
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return step * base
}

/** Evenly spaced ticks from 0 to max, ascending, de-duplicated (max === 0 or
 * count <= 0 collapses to a single [0]). */
export function ticks(max: number, count: number): readonly number[] {
  if (!Number.isFinite(max) || max <= 0 || count <= 0) return [0]
  const step = max / count
  const out = new Set<number>()
  for (let i = 0; i <= count; i++) out.add(Math.round((step * i + Number.EPSILON) * 1000) / 1000)
  return Array.from(out).sort((a, b) => a - b)
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
