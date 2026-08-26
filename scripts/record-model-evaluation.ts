/**
 * `npm run record-eval` — writes the real, already-committed evaluation numbers
 * into `model_evaluations` for real. SYSTEM_SPEC.md §4.1/§11.1 name this table
 * as "the receipt proving the evaluation happened instead of being eyeballed" —
 * `src/repositories/model-evaluations.repo.ts`'s `recordEvaluation` has existed
 * since D3, fully real, and was simply never called. This closes that for real,
 * against whichever database `DATABASE_URL` points at (requires a real Postgres,
 * not PGlite — a one-off write like this is exactly the kind of thing PGlite's
 * single-connection limit makes risky to run alongside `next dev`).
 *
 * Reads nothing but committed artifacts, the same discipline `scripts/report.py`
 * already holds to: `recovery_model.json`'s own held-out Brier, and
 * `docs/risk_eval_results.json`'s own precision/recall/false-positive-cost —
 * never a hand-typed number.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNodePgExecutor } from '../src/adapters/db/node-pg'
import { recordEvaluation } from '../src/repositories/model-evaluations.repo'

const REPO_ROOT = join(import.meta.dirname, '..')

interface RecoveryModelMetrics {
  readonly n_demo: number
  readonly brier_after_platt: number
  readonly roc_auc: number
  readonly bss: number
}
interface RecoveryModelFile {
  readonly metrics: RecoveryModelMetrics
}

interface RiskEvalFile {
  readonly n_demo: number
  readonly pr_auc: number
  readonly best_threshold: number
  readonly at_best_threshold: {
    readonly precision: number
    readonly recall: number
    readonly false_positive_cost_inr: number
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL must be set — model_evaluations only exists on real Postgres, not PGlite.')
  }

  const recoveryModel = JSON.parse(
    readFileSync(join(REPO_ROOT, 'data/synthetic/subscription/recovery_model.json'), 'utf8'),
  ) as RecoveryModelFile
  // docs/risk_eval_results.json contains bare `Infinity` literals (a real,
  // pre-existing artifact bug: Python's json.dump writes them by default for a
  // PR-curve's boundary point, which is not valid JSON — no JS consumer of this
  // file can `JSON.parse` it as-is). Sanitized here rather than silently
  // swallowed: the only field this script reads that could plausibly be
  // Infinity is inside `pr_curve`, which this script never touches.
  const riskEvalRaw = readFileSync(join(REPO_ROOT, 'docs/risk_eval_results.json'), 'utf8').replace(
    /:\s*-?Infinity/g,
    ': null',
  )
  const riskEval = JSON.parse(riskEvalRaw) as RiskEvalFile

  const sql = createNodePgExecutor(databaseUrl)
  try {
    const recoveryRow = await recordEvaluation(sql, {
      modelName: 'subscription_recovery_scorer_v1',
      evalSetSize: recoveryModel.metrics.n_demo,
      brierScore: recoveryModel.metrics.brier_after_platt,
      notes: `ROC-AUC ${recoveryModel.metrics.roc_auc.toFixed(4)}, BSS ${recoveryModel.metrics.bss.toFixed(4)}, ` +
        `on logged_demo. See docs/RESULTS.md and docs/MODEL_COMPARISON.md for the full account, ` +
        `including the real logistic-vs-gradient-boosting benchmark.`,
    })
    console.log(`recovery scorer row: ${recoveryRow.id} (${recoveryRow.createdAt.toISOString()})`)

    const riskRow = await recordEvaluation(sql, {
      modelName: 'subscription_risk_gate_v1',
      evalSetSize: riskEval.n_demo,
      precisionScore: riskEval.at_best_threshold.precision,
      recallScore: riskEval.at_best_threshold.recall,
      // INR -> milli-paise: 1 INR = 100 paise = 100,000 milli-paise.
      falsePositiveCostMilli: Math.round(riskEval.at_best_threshold.false_positive_cost_inr * 100_000),
      notes: `PR-AUC ${riskEval.pr_auc.toFixed(4)} at threshold ${riskEval.best_threshold}. ` +
        `See docs/EVALUATION.md's D11 section for the full account.`,
    })
    console.log(`risk gate row: ${riskRow.id} (${riskRow.createdAt.toISOString()})`)
  } finally {
    await sql.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
