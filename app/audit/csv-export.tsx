'use client'

/**
 * BUILD_PLAN.md §3.8: "CSV export on the audit table." Exports exactly the rows
 * currently rendered (post-filter), client-side — no extra round trip, and the
 * export can never disagree with what is on screen since it is built from the
 * same data the table already has.
 */
import type { AuditRowData } from './audit-row'

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function toCsv(rows: readonly AuditRowData[]): string {
  const header = ['created_at', 'transaction_id', 'chosen_action', 'execution_mode', 'outcome', 'amount_paise', 'ev_milli', 'uplift_milli']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.createdAt,
        r.transactionId ?? '',
        r.chosenAction,
        r.executionMode,
        r.outcome ?? '',
        r.amountPaise ?? '',
        r.evMilli ?? '',
        r.upliftMilli ?? '',
      ]
        .map((v) => csvEscape(String(v)))
        .join(','),
    )
  }
  return lines.join('\n')
}

export function CsvExportButton({ rows }: { rows: readonly AuditRowData[] }): React.JSX.Element {
  function download(): void {
    const csv = toCsv(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reclaim-audit-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={rows.length === 0}
      className="rounded-full border border-ink-line px-5 py-2 text-[0.625rem] tracking-[0.08em] text-on-ink-soft uppercase hover:border-accent hover:text-accent disabled:opacity-40"
    >
      Export CSV
    </button>
  )
}
