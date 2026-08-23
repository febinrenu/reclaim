/**
 * The ONLY file in the codebase permitted to read process.env.
 * ESLint boundary rule 3 enforces that.
 *
 * The governing principle: every variable is optional. A missing credential is
 * never a startup error. It selects a local adapter and is reported in the boot
 * banner. That is what makes `git clone && npm install && npm run dev` work with
 * an empty environment, which the spec identifies as the single highest-leverage
 * property of the repository.
 */
import { z } from 'zod'

/** Treat empty and whitespace-only strings as absent, which is what a blank .env line means. */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v

const optionalStr = z.preprocess(blankToUndefined, z.string().min(1).optional())

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: optionalStr,

  UPSTASH_REDIS_REST_URL: optionalStr,
  UPSTASH_REDIS_REST_TOKEN: optionalStr,

  GROQ_API_KEY: optionalStr,
  GROQ_MODEL: z.preprocess(blankToUndefined, z.string().min(1).default('openai/gpt-oss-20b')),

  RAZORPAY_KEY_ID: optionalStr,
  RAZORPAY_KEY_SECRET: optionalStr,
  RAZORPAY_WEBHOOK_SECRET: optionalStr,

  EXECUTOR_MODE: z.preprocess(blankToUndefined, z.enum(['dry_run', 'live', 'auto']).default('dry_run')),
  EXECUTOR_LIVE_BUDGET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined),
    z.number().int().min(0).default(5),
  ),

  // Explicit adapter overrides. Normally unnecessary; auto-detection handles it.
  DB_DRIVER: z.preprocess(blankToUndefined, z.enum(['pglite', 'postgres']).optional()),
  KV_DRIVER: z.preprocess(blankToUndefined, z.enum(['memory', 'postgres', 'upstash']).optional()),
  LLM_DRIVER: z.preprocess(blankToUndefined, z.enum(['template', 'groq']).optional()),
  PAYMENTS_DRIVER: z.preprocess(blankToUndefined, z.enum(['simulator', 'razorpay']).optional()),

  PGLITE_DATA_DIR: z.preprocess(blankToUndefined, z.string().min(1).default('.data/pglite')),
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['debug', 'info', 'warn', 'error']).default('info')),

  /**
   * Deliberate crash injection, so the durability story is reproducible on camera
   * rather than dependent on landing a kill at the right microsecond.
   * See BUILD_PLAN.md 5.6.
   */
  RECLAIM_CRASH_AFTER: z.preprocess(blankToUndefined, z.enum(['intent', 'claim', 'settle']).optional()),

  /**
   * For the crash-recovery demo: a standalone `npm run worker` process needs to
   * be the *only* worker claiming jobs, or which process lands the crash-designated
   * job becomes a race — fine functionally (SKIP LOCKED makes it safe either way),
   * but it breaks the demo's reproducibility. Set on the `next dev` process during
   * that demo beat only; there is no reason to set it otherwise, since the embedded
   * worker racing a standalone one is exactly what BUILD_PLAN.md §5.7's SKIP LOCKED
   * design is for. Requires DATABASE_URL: PGlite is single-process and cannot
   * support `next dev` and a standalone worker holding the same file open at once,
   * with or without this flag.
   */
  DISABLE_EMBEDDED_WORKER: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() === '1' || v.trim().toLowerCase() === 'true' : false),
    z.boolean().default(false),
  ),
})

export type Env = z.infer<typeof EnvSchema>

/**
 * A live Razorpay key would let a demo move real money. There is no legitimate
 * reason for one to be present, so this is a hard refusal rather than a warning.
 */
function refuseLiveKeys(env: Env): void {
  if (env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) {
    throw new Error(
      'RAZORPAY_KEY_ID is a LIVE key. Reclaim refuses to start with live credentials. ' +
        'Use a test key (rzp_test_...). Rotate this key now if it was committed anywhere.',
    )
  }
}

let cached: Env | null = null

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached !== null && source === process.env) return cached

  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment:\n${detail}`)
  }

  refuseLiveKeys(parsed.data)
  if (source === process.env) cached = parsed.data
  return parsed.data
}

/** Test-only, so one test's environment cannot leak into the next. */
export function resetEnvCache(): void {
  cached = null
}
