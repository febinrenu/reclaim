# Runbook

Written on D9, rehearsed on D11 and D12 (BUILD_PLAN.md's own rule: write the day the
runnable thing exists, not the day before recording). This is the sequence an operator —
or the demo recording — actually follows, in order, with the exact commands.

## 1. Zero-config path (what a fresh clone gets)

```
git clone <repo>
cd reclaim
npm install
npm run dev
```

No `.env` needed. `npm run dev` boots against embedded PGlite, in-memory KV, the
payments simulator, and the template-only language adapter. `/api/health` reports
every port's adapter and whether it is live. This is the path CI exercises and the
path a reviewer with zero credentials gets.

## 2. The fuller path (real Postgres, real Groq)

```
docker compose up -d          # postgres:17-alpine, user reclaim / reclaim_dev_only, db reclaim
cp .env.example .env          # then fill in DATABASE_URL and GROQ_API_KEY
npm run dev                   # or: npm run build && npm run start for a production build
```

`/api/health` should now show `sql.adapter: node-pg, live: true` and
`llm.adapter: groq, live: true`. Never commit `.env` — it is gitignored, and the
pre-commit hook scans staged diffs for secret-shaped strings regardless.

## 3. Run the test suite

```
npm test                      # TypeScript: unit + property + integration, Vitest
npm run eval                  # Python: eval/, pytest — the oracle firewall, overlap,
                               # generator-difficulty, and off-policy tests
npm run typecheck
npm run lint
```

323 TypeScript tests (337 counting the two live-gated ones that only run with
`GROQ_API_KEY`/`DATABASE_URL` set) and 23 Python tests, all green, as of D8.

## 4. Regenerate the synthetic data and retrain (only if `scripts/data/` changed)

```
npm run data:generate
npm run data:verify           # re-hashes every generated file against the manifest
npm run scorer:train          # writes recovery_model.json + docs/calibration_recovery_v1.png
npm run ope                   # writes docs/ope_results.json — the six-policy bracket
npm run risk:eval             # writes docs/risk_eval_results.json — the PR curve, the cost bracket
npm run report                # writes docs/RESULTS.md from the three artifacts above — never hand-typed
```

The same four commands exist for the B2B scenario, suffixed `:b2b` (`data:generate:b2b`,
`data:verify:b2b`, `scorer:train:b2b`) — no separate `ope`/`risk:eval` for B2B, since
that scenario is exercised through the policy simulator and offline training only, not
a live OPE/risk-gate run (`docs/adr/0007`).

Regenerating is only necessary after touching `scripts/data/dgp.py`,
`logging_policy.py`, or `risk.py` — the committed `recovery_model.json` and
`ope_results.json` already reflect the current generator.

## 5. Run a synthetic batch replay from the command line

```
npm run build && npm run start          # a production build measures real latency
npm run replay -- --n 50                # posts 50 signed synthetic events, reports p50/p95
```

Expect `202` for all 50, and the worker to drain them into 50 audit rows within a
few seconds. `docs/INCIDENTS.md` has the measured latency numbers and the two real
bugs this exact command surfaced during D6.

## 6. Run a batch from the dashboard (the demo path)

```
npm run build && npm run start
```

Then, in a browser, open `http://localhost:3000/dashboard`, set a batch size (up to
300, SYSTEM_SPEC.md §9), and click **Run batch**. The counters stream live over
Server-Sent Events; the transport indicator reads **SSE**. When the batch finishes,
every SYSTEM_SPEC.md §13 metric renders: revenue at risk, revenue recovered, the
naive-baseline comparison (retry-everything, computed on this exact batch under the
same synthetic ground-truth draw — BUILD_PLAN.md §6.5's B1), the action distribution,
the `DO_NOTHING` breakdown by reason, and p50/p95 decision latency.

**To rehearse the polling fallback** (BUILD_PLAN.md C5: the dev tunnel does not
support SSE, and the dashboard must never depend on it there): block the browser
from opening the `/stream` route — devtools' network conditions panel, or simply
running behind a tunnel — and confirm the transport indicator flips to **Polling**
and the same numbers land, just less smoothly. The two transports read the identical
`getBatchReport` call (`src/app/batch/run-batch.ts`), so they cannot disagree by
construction; `tests/integration/batch-runner.test.ts` checks this directly.

Every event in a dashboard batch is a synthetic, signed `payment.failed` delivery
through the real webhook path (`ingestRazorpayEvent`) — same signature check, same
queue, same worker a live Razorpay delivery would hit. `resolveExecutionMode`
(`src/ports/executor.ts`) makes `source: 'batch_replay'` structurally `dry_run`
regardless of which credentials are present — BUILD_PLAN.md's D8 exit test.

## 7. The crash-recovery demo

```
RECLAIM_CRASH_AFTER=intent DISABLE_EMBEDDED_WORKER=true npm run worker &
npm run replay -- --n 10
# once one job crashes the worker process (visible in its own output):
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *worker*"   # or find the PID and kill -9 it
DISABLE_EMBEDDED_WORKER=true npm run worker               # restart; it reclaims the crashed job
```

Confirm via `docker compose exec -T postgres psql -U reclaim -d reclaim -c
"SELECT count(*) FROM recovery_audit WHERE event_id = '<the crashed event>';"` — exactly
one row, never zero, never two. Full account of the two real bugs this surfaced (the
`after()` self-kick race, and the missing-parent-directory PGlite bug from D2) is in
`docs/INCIDENTS.md`.

## 8. The systemic-shock demo (D11, not yet built)

Placeholder for D11: `npm run burst` will fire 30-40 synthetic failures sharing a
bank/error code in quick succession and the dashboard should show the decision
distribution shift mid-batch.

## Known operational notes

- **PGlite is single-connection.** Never run two processes against the same
  `.data/` directory at once — use Docker Postgres (`DATABASE_URL` set) for anything
  that needs concurrent access, including the crash-recovery demo above.
- **The tunnel must never be on the dashboard streaming path** (BUILD_PLAN.md C5) —
  record the SSE demo on `localhost`, and only use a tunnel for real webhook
  delivery (SYSTEM_SPEC.md §9, D13).
- **`.env` is never committed.** The pre-commit secret scanner blocks it either way,
  but the habit matters more than the backstop.
