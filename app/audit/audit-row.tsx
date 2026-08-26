'use client'

import { useState } from 'react'
import { EvExplorer } from './ev-explorer'
import type { EvBreakdownEntry } from './view-model'
import { formatPaise, ACTION_LABELS } from '~/_viz/format'

const OUTCOME_GLYPH: Record<string, string> = {
  success: '✓',
  failed: '✕',
  pending: '…',
  skipped: '–',
  unknown: '?',
}

export interface AuditRowData {
  readonly id: string
  readonly createdAt: string
  readonly transactionId: string | null
  readonly chosenAction: string
  readonly executionMode: 'dry_run' | 'live'
  readonly outcome: string | null
  readonly amountPaise: number | null
  readonly evMilli: number | null
  readonly upliftMilli: number | null
  readonly rationale: string | null
  readonly breakdown: readonly EvBreakdownEntry[] | null
}

export function AuditRow({ row }: { row: AuditRowData }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr className="border-b border-ink-line">
        <td className="py-3 pr-4 text-on-ink-muted">
          {new Date(row.createdAt).toLocaleTimeString('en-IN', { hour12: false })}
        </td>
        <td className="py-3 pr-4 font-mono text-on-ink-soft">{row.transactionId ?? '—'}</td>
        <td className="py-3 pr-4 font-bold">{ACTION_LABELS[row.chosenAction] ?? row.chosenAction}</td>
        <td className="py-3 pr-4">
          <span
            className="rounded-full px-2 py-0.5 text-[0.625rem] tracking-[0.08em] uppercase"
            style={{
              backgroundColor: row.executionMode === 'live' ? 'var(--color-pos)' : 'var(--color-ink-line)',
              color: row.executionMode === 'live' ? 'var(--color-on-ink)' : 'var(--color-on-ink-soft)',
            }}
          >
            {row.executionMode === 'live' ? '● live' : '○ dry run'}
          </span>
        </td>
        <td className="py-3 pr-4 text-on-ink-soft">
          <span aria-hidden="true">{row.outcome !== null ? (OUTCOME_GLYPH[row.outcome] ?? '?') : '—'}</span>{' '}
          {row.outcome ?? 'n/a'}
        </td>
        <td className="py-3 pr-4 text-right tnum">{row.amountPaise !== null ? formatPaise(row.amountPaise) : '—'}</td>
        <td className="py-3 text-right">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="text-[0.625rem] tracking-[0.08em] text-accent uppercase hover:opacity-80"
            disabled={row.breakdown === null}
          >
            {row.breakdown === null ? 'No breakdown' : expanded ? 'Hide' : 'Why?'}
          </button>
        </td>
      </tr>
      {expanded && row.breakdown !== null && (
        <tr className="border-b border-ink-line bg-ink-raised">
          <td colSpan={7} className="p-6">
            <EvExplorer breakdown={row.breakdown} chosenAction={row.chosenAction} rationale={row.rationale} />
          </td>
        </tr>
      )}
    </>
  )
}
