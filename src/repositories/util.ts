/**
 * `noUncheckedIndexedAccess` (tsconfig.json) types every array index as possibly
 * `undefined`, correctly for most reads. An `INSERT ... RETURNING *` is different: it
 * either raises (a constraint violation, a missing FK) or returns exactly one row.
 * This makes that guarantee explicit at the one place it is actually true, instead of
 * asserting it away at every call site.
 */
export function requireRow<T>(rows: readonly T[], context: string): T {
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`${context}: expected exactly one row back, got none`)
  }
  return row
}
