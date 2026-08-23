/**
 * Node-only boot work. Kept in its own module because instrumentation.ts is
 * compiled for BOTH the Node and Edge runtimes, and a static reference to
 * process.stdout there fails the Edge compilation even when it is guarded at
 * runtime. The guard has to be a dynamic import boundary, not an if statement.
 *
 * From D2, boot also applies migrations before anything else can touch the database:
 * `runMigrations` is idempotent, so this is safe to run on every boot, including a
 * Turbopack hot-reload re-run.
 */
import { getDeps } from '@/server/di'
import { runMigrations } from '@/db/migrate'
import { renderBanner } from '@/config/banner'
import { VERSION } from '@/config/version'
import { startEmbeddedWorker } from '@/server/embedded-worker'

export async function boot(): Promise<void> {
  try {
    const deps = await getDeps()
    const { applied, alreadyCurrent } = await runMigrations(deps.sql)

    // stdout directly rather than through the logger: this is a banner for a human
    // reading a terminal, not a record for a machine to parse.
    process.stdout.write(
      renderBanner({
        version: VERSION,
        capabilities: deps.capabilities,
        extraLines: [
          alreadyCurrent
            ? `database schema: up to date (${deps.sql.describe})`
            : `database schema: applied ${applied.join(', ')}`,
        ],
      }),
    )

    deps.logger.info(
      {
        event: 'boot',
        version: VERSION,
        mode: deps.capabilities.fullyLocal ? 'local' : deps.capabilities.allLive ? 'live' : 'mixed',
        adapters: Object.fromEntries(deps.capabilities.rows.map((r) => [r.port, r.adapter])),
        migrationsApplied: applied,
      },
      'reclaim started',
    )

    if (!deps.env.DISABLE_EMBEDDED_WORKER) {
      startEmbeddedWorker(deps)
    }
  } catch (err) {
    // A configuration error must be legible, not a stack trace buried in a framework
    // wrapper. The usual cause is a driver override contradicting the credentials.
    process.stderr.write(
      `\n  Reclaim failed to start.\n  ${err instanceof Error ? err.message : String(err)}\n\n`,
    )
    throw err
  }
}
