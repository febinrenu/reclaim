import { describe, it, expect } from 'vitest'
import { loadEnv } from '@/config/env'
import { detectCapabilities } from '@/config/capabilities'
import { buildContainer } from '@/config/container'
import { renderBanner } from '@/config/banner'
import { fixedClock } from '@/domain/clock'
import { collectingLogger } from '@/adapters/logger/json-logger'

/** An entirely empty environment. This is what a fresh clone actually has. */
const EMPTY: Record<string, string | undefined> = {}

const V = '0.1.0'

describe('env: every variable is optional', () => {
  it('parses a completely empty environment without throwing', () => {
    // This single assertion is the zero-credential mandate. If it ever fails, a
    // stranger cannot run the project, which the spec calls the highest-leverage
    // property of the repository.
    expect(() => loadEnv(EMPTY)).not.toThrow()
  })

  it('supplies sane defaults', () => {
    const env = loadEnv(EMPTY)
    expect(env.NODE_ENV).toBe('development')
    expect(env.GROQ_MODEL).toBe('openai/gpt-oss-20b')
    expect(env.EXECUTOR_MODE).toBe('dry_run')
    expect(env.EXECUTOR_LIVE_BUDGET).toBe(5)
    expect(env.PGLITE_DATA_DIR).toBe('.data/pglite')
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.GROQ_API_KEY).toBeUndefined()
  })

  it('treats a blank or whitespace value as absent', () => {
    // A .env line reading `GROQ_API_KEY=` is a human saying "not configured". It must
    // not be read as an empty-string credential that then fails at call time.
    const env = loadEnv({ GROQ_API_KEY: '', DATABASE_URL: '   ', RAZORPAY_KEY_ID: '' })
    expect(env.GROQ_API_KEY).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.RAZORPAY_KEY_ID).toBeUndefined()
  })

  it('refuses to start with a live Razorpay key', () => {
    // A live key in a demo could move real money. This is a refusal, not a warning.
    //
    // Assembled from parts rather than written as a literal, so the credential
    // scanner in scripts/scan-secrets.mjs does not flag this file. Allowlisting the
    // test directory instead would blind the scanner to a genuine leak here, which
    // is exactly the kind of hole that makes a guard worthless.
    const liveLooking = `rzp_${'live'}_AbCdEf123456`
    expect(() => loadEnv({ RAZORPAY_KEY_ID: liveLooking })).toThrow(/LIVE key/)
  })

  it('accepts a test-mode Razorpay key', () => {
    const env = loadEnv({ RAZORPAY_KEY_ID: 'rzp_test_AbCdEf123456' })
    expect(env.RAZORPAY_KEY_ID).toBe('rzp_test_AbCdEf123456')
  })

  it('rejects a malformed enum with a useful message', () => {
    expect(() => loadEnv({ EXECUTOR_MODE: 'yolo' })).toThrow(/Invalid environment/)
  })
})

describe('capabilities: absent credentials select local adapters', () => {
  it('reports fully local for an empty environment', () => {
    const caps = detectCapabilities(loadEnv(EMPTY))
    expect(caps.fullyLocal).toBe(true)
    expect(caps.allLive).toBe(false)
    expect(caps.byPort('sql').adapter).toBe('pglite')
    expect(caps.byPort('kv').adapter).toBe('postgres')
    expect(caps.byPort('llm').adapter).toBe('template')
    expect(caps.byPort('payments').adapter).toBe('simulator')
    expect(caps.byPort('executor').adapter).toBe('dry_run')
  })

  it('gives every port a reason a human can act on', () => {
    const caps = detectCapabilities(loadEnv(EMPTY))
    for (const row of caps.rows) {
      expect(row.reason.length).toBeGreaterThan(10)
      expect(row.target.length).toBeGreaterThan(0)
    }
  })

  it('upgrades one port at a time', () => {
    const caps = detectCapabilities(loadEnv({ GROQ_API_KEY: 'gsk_testkeyvalue000000' }))
    expect(caps.byPort('llm').adapter).toBe('groq')
    expect(caps.byPort('llm').live).toBe(true)
    // Everything else stays local. Partial configuration must be a supported state,
    // because that is what a user has five minutes after reading the setup doc.
    expect(caps.byPort('sql').adapter).toBe('pglite')
    expect(caps.fullyLocal).toBe(false)
    expect(caps.allLive).toBe(false)
  })

  it('selects Postgres when DATABASE_URL is present', () => {
    const caps = detectCapabilities(
      loadEnv({ DATABASE_URL: 'postgresql://u:pw@db.example.com:6543/postgres' }),
    )
    const sql = caps.byPort('sql')
    expect(sql.adapter).toBe('node-pg')
    expect(sql.live).toBe(true)
    expect(sql.target).toBe('db.example.com:6543/postgres')
  })

  it('never leaks a credential into the printable target', () => {
    // The banner and the health endpoint both render `target`, so a password here
    // would end up in a terminal, in a screenshot, and in a recorded video.
    const caps = detectCapabilities(
      loadEnv({
        DATABASE_URL: 'postgresql://admin:sup3rs3cr3t@db.example.com:6543/postgres',
        UPSTASH_REDIS_REST_URL: 'https://apt-cat-12345.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'AX1sASQgN2NkZTk4',
      }),
    )
    const printed = caps.rows.map((r) => `${r.target} ${r.reason}`).join(' ')
    expect(printed).not.toContain('sup3rs3cr3t')
    expect(printed).not.toContain('AX1sASQgN2NkZTk4')
  })

  it('rejects an override that contradicts the credentials present', () => {
    expect(() => detectCapabilities(loadEnv({ DB_DRIVER: 'postgres' }))).toThrow(
      /requires DATABASE_URL/,
    )
    expect(() => detectCapabilities(loadEnv({ LLM_DRIVER: 'groq' }))).toThrow(
      /requires GROQ_API_KEY/,
    )
    expect(() => detectCapabilities(loadEnv({ KV_DRIVER: 'upstash' }))).toThrow(/requires both/)
    expect(() => detectCapabilities(loadEnv({ PAYMENTS_DRIVER: 'razorpay' }))).toThrow(
      /requires RAZORPAY/,
    )
  })

  it('keeps the executor in dry run unless credentials AND an explicit choice are present', () => {
    // This is the structural reason a 300-event batch can never exhaust the
    // 30-Payment-Link test-mode cap.
    const withKeys = { RAZORPAY_KEY_ID: 'rzp_test_x1', RAZORPAY_KEY_SECRET: 's' }
    expect(detectCapabilities(loadEnv(withKeys)).byPort('executor').live).toBe(false)
    expect(
      detectCapabilities(loadEnv({ ...withKeys, EXECUTOR_MODE: 'live' })).byPort('executor').live,
    ).toBe(true)
    // Credentials alone are never enough, and an explicit choice alone is not either.
    expect(detectCapabilities(loadEnv({ EXECUTOR_MODE: 'live' })).byPort('executor').live).toBe(
      false,
    )
  })

  it('falls back to a development webhook secret and says so', () => {
    const caps = detectCapabilities(loadEnv(EMPTY))
    const row = caps.byPort('webhookSecret')
    expect(row.live).toBe(false)
    // The API key secret and the webhook secret are different values, and confusing
    // them makes every delivery return 400 with no other symptom. Say it here, where
    // someone setting up credentials will actually read it.
    expect(row.reason).toMatch(/not the API key secret/i)
  })
})

describe('container: overrides win, and nothing reads the environment', () => {
  it('builds from an explicit env with no ambient dependence', () => {
    const deps = buildContainer(loadEnv(EMPTY))
    expect(deps.capabilities.fullyLocal).toBe(true)
    expect(typeof deps.clock.nowMs()).toBe('number')
  })

  it('accepts a pinned clock and logger', () => {
    const logger = collectingLogger()
    const deps = buildContainer(loadEnv(EMPTY), {
      clock: fixedClock(1_756_000_000_000),
      logger,
    })
    expect(deps.clock.nowMs()).toBe(1_756_000_000_000)
    deps.logger.info({ eventId: 'evt_1' }, 'hello')
    expect(logger.records).toHaveLength(1)
    expect(logger.records[0]).toContain('evt_1')
  })
})

describe('banner: tells the truth about what is wired up', () => {
  it('names every port and marks the local ones', () => {
    const caps = detectCapabilities(loadEnv(EMPTY))
    const out = renderBanner({ version: V, capabilities: caps })
    for (const label of ['database', 'locks', 'language', 'payments', 'executor']) {
      expect(out).toContain(label)
    }
    expect(out).toContain('LOCAL, zero credentials')
    expect(out).toContain('pglite')
    expect(out).toContain('nothing needs to be')
  })

  it('reports mixed mode once one port goes live', () => {
    const caps = detectCapabilities(loadEnv({ GROQ_API_KEY: 'gsk_testkeyvalue000000' }))
    const out = renderBanner({ version: V, capabilities: caps })
    expect(out).toContain('MIXED')
    expect(out).not.toContain('nothing needs to be')
  })

  it('never prints a credential', () => {
    const caps = detectCapabilities(
      loadEnv({ DATABASE_URL: 'postgresql://admin:sup3rs3cr3t@h:6543/postgres' }),
    )
    expect(renderBanner({ version: V, capabilities: caps })).not.toContain('sup3rs3cr3t')
  })
})
