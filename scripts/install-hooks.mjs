// Points git at .githooks/ so the secret guard runs for every contributor.
// Idempotent, and a no-op outside a git work tree (e.g. inside a published tarball or CI cache).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('.git')) {
  console.log('[hooks] no .git directory, skipping')
  process.exit(0)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'pipe' })
  console.log('[hooks] core.hooksPath -> .githooks')
} catch (err) {
  // Never fail an install over a hook. A missing guard is a warning, not a blocker.
  console.warn('[hooks] could not set core.hooksPath:', err.message)
}
