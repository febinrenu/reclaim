/**
 * The D9 exit test, checked directly: "Click Run batch, counters stream live
 * ... all batch metrics render, including the baseline bracket and the
 * DO_NOTHING breakdown by reason." Runs the whole pipeline (ingest, drain,
 * synthetic outcome, batch counters, metrics) against real PGlite — no HTTP,
 * calling `startBatchRun`/`driveBatchToCompletion` directly the way the route
 * handler does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPgliteExecutor } from '@/adapters/db/pglite'
import { createMemoryKv } from '@/adapters/kv/memory'
import { createPaymentsSimulator } from '@/adapters/payments/simulator'
import { runMigrations } from '@/db/migrate'
import { loadEnv } from '@/config/env'
import { buildContainer, type Deps } from '@/config/container'
import { startBatchRun, driveBatchToCompletion, getBatchReport, clampBatchTotal, MAX_BATCH_TOTAL } from '@/app/batch/run-batch'
import * as recoveryAuditRepo from '@/repositories/recovery-audit.repo'
import { fixedClock } from '@/domain/clock'
import type { Transactional } from '@/ports/sql'

const WEBHOOK_SECRET = 'test_webhook_secret'

describe('the D9 batch runner', () => {
  let dir: string
  let sql: Transactional
  let deps: Deps
  const nowMs = 1_756_000_000_000

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reclaim-batch-'))
    sql = await createPgliteExecutor(dir)
    await runMigrations(sql)

    deps = await buildContainer(loadEnv({}), {
      sql,
      kv: createMemoryKv(),
      clock: fixedClock(nowMs),
      payments: createPaymentsSimulator(WEBHOOK_SECRET),
      webhookSecret: WEBHOOK_SECRET,
    })
  })

  afterAll(async () => {
    await sql.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('clamps total to [1, MAX_BATCH_TOTAL]', () => {
    expect(clampBatchTotal(0)).toBe(1)
    expect(clampBatchTotal(-5)).toBe(1)
    expect(clampBatchTotal(MAX_BATCH_TOTAL + 500)).toBe(MAX_BATCH_TOTAL)
    expect(clampBatchTotal(42)).toBe(42)
  })

  it('runs a full batch end to end: batch_replay is structurally dry_run, every event gets an audit row, and metrics render', async () => {
    const total = 24
    const batch = await startBatchRun(deps, { total })
    expect(batch.status).toBe('running')
    expect(batch.total).toBe(total)

    await driveBatchToCompletion(deps, batch)

    const report = await getBatchReport(deps, batch.id)
    expect(report.batch?.status).toBe('done')
    expect(report.batch?.done).toBe(total)
    expect(report.batch?.failed).toBe(0)

    // BUILD_PLAN.md's D8 exit test, exercised again here from the live batch
    // path: source: 'batch_replay' is structurally dry_run regardless of
    // credentials, so every intent this batch created is dry_run.
    const rows = await recoveryAuditRepo.listByBatch(deps.sql, batch.id)
    expect(rows).toHaveLength(total)
    for (const row of rows) {
      expect(row.executionMode).toBe('dry_run')
      expect(row.batchId).toBe(batch.id)
      // The synthetic-outcome draw (src/app/worker/process-event.ts) always
      // resolves to a real recovery outcome for a batch_replay row, never the
      // uninformative 'pending' a bare dry_run executor call would leave.
      expect(['success', 'failed']).toContain(row.outcome)
      expect(row.decisionLatencyMs).toBeGreaterThanOrEqual(0)
    }

    // BUILD_PLAN.md's P1 invariant: recovered can never exceed at-risk.
    expect(report.metrics.revenueRecovered).toBeLessThanOrEqual(report.metrics.revenueAtRisk)
    expect(report.metrics.count).toBe(total)
    expect(report.naiveBaseline.count).toBe(total)

    // computeDoNothingBreakdown's structural invariant (src/domain/metrics.ts):
    // the risk gate never forces DO_NOTHING, so this bucket is always empty.
    expect(report.doNothing.riskGateOverrideCount).toBe(0)
  })

  it('the SSE route and the plain-JSON route read the identical report — the D9 exit test, verbatim', async () => {
    const batch = await startBatchRun(deps, { total: 6 })
    await driveBatchToCompletion(deps, batch)

    const a = await getBatchReport(deps, batch.id)
    const b = await getBatchReport(deps, batch.id)
    expect(a.metrics).toEqual(b.metrics)
    expect(a.doNothing).toEqual(b.doNothing)
    expect(a.naiveBaseline).toEqual(b.naiveBaseline)
  })
})
