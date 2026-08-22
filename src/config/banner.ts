/**
 * The boot banner.
 *
 * This exists because of a specific reviewer failure mode. Someone clones the
 * repository, runs it with no credentials, sees plausible numbers, and cannot tell
 * which parts are real. Either they assume everything is faked and discount the
 * whole thing, or they assume everything is live and are misled. Both are bad.
 *
 * So the app states its own configuration, in plain language, on every boot and at
 * /api/health, and the dashboard header shows the same thing. Being explicit about
 * what is simulated is what buys the right to simulate anything at all.
 */
import type { Capabilities, Capability } from './capabilities'

const PORT_LABEL: Record<Capability['port'], string> = {
  sql: 'database',
  kv: 'locks',
  llm: 'language',
  payments: 'payments',
  webhookSecret: 'webhook key',
  executor: 'executor',
}

export interface BannerInput {
  readonly version: string
  readonly capabilities: Capabilities
  readonly extraLines?: readonly string[]
}

export function renderBanner({ version, capabilities, extraLines = [] }: BannerInput): string {
  const mode = capabilities.fullyLocal
    ? 'LOCAL, zero credentials'
    : capabilities.allLive
      ? 'FULLY LIVE'
      : 'MIXED, some ports live'

  const lines: string[] = []
  lines.push('')
  lines.push(`  Reclaim ${version}   mode: ${mode}`)
  lines.push('  ' + '-'.repeat(74))

  const labelWidth = Math.max(...capabilities.rows.map((r) => PORT_LABEL[r.port].length))
  const adapterWidth = Math.max(...capabilities.rows.map((r) => r.adapter.length))
  const targetWidth = Math.min(28, Math.max(...capabilities.rows.map((r) => r.target.length)))

  for (const row of capabilities.rows) {
    const marker = row.live ? 'live' : ' -  '
    lines.push(
      '  ' +
        [
          marker,
          PORT_LABEL[row.port].padEnd(labelWidth),
          row.adapter.padEnd(adapterWidth),
          truncate(row.target, targetWidth).padEnd(targetWidth),
          row.reason,
        ].join('  '),
    )
  }

  if (extraLines.length > 0) {
    lines.push('  ' + '-'.repeat(74))
    for (const l of extraLines) lines.push(`  ${l}`)
  }

  if (capabilities.fullyLocal) {
    lines.push('  ' + '-'.repeat(74))
    lines.push('  Nothing is configured, and nothing needs to be. Every number you are about')
    lines.push('  to see is computed by the real decision engine over generated data.')
    lines.push('  See docs/SETUP.md to point any single port at a real service.')
  }

  lines.push('')
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}
