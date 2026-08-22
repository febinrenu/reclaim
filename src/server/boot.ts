/**
 * Node-only boot work. Kept in its own module because instrumentation.ts is
 * compiled for BOTH the Node and Edge runtimes, and a static reference to
 * process.stdout there fails the Edge compilation even when it is guarded at
 * runtime. The guard has to be a dynamic import boundary, not an if statement.
 */
import { getDeps } from '@/server/di'
import { renderBanner } from '@/config/banner'
import { VERSION } from '@/config/version'

export function boot(): void {
  try {
    const { capabilities, logger } = getDeps()

    // stdout directly rather than through the logger: this is a banner for a human
    // reading a terminal, not a record for a machine to parse.
    process.stdout.write(renderBanner({ version: VERSION, capabilities }))

    logger.info(
      {
        event: 'boot',
        version: VERSION,
        mode: capabilities.fullyLocal ? 'local' : capabilities.allLive ? 'live' : 'mixed',
        adapters: Object.fromEntries(capabilities.rows.map((r) => [r.port, r.adapter])),
      },
      'reclaim started',
    )
  } catch (err) {
    // A configuration error must be legible, not a stack trace buried in a framework
    // wrapper. The usual cause is a driver override contradicting the credentials.
    process.stderr.write(
      `\n  Reclaim failed to start.\n  ${err instanceof Error ? err.message : String(err)}\n\n`,
    )
    throw err
  }
}
