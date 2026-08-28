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
every SYSTEM_SPEC.md §13 metric renders: revenue at risk, the action distribution,
intervention spend, customers contacted, the `DO_NOTHING` breakdown by reason, p50/p95
decision latency, and the naive-baseline comparison (retry-everything, computed on this
exact batch — BUILD_PLAN.md §6.5's B1).

**Read the recovered column as a projection, not a measurement.** Both policies' outcomes
are drawn against their own chosen action's predicted `pRecover` under a shared seed, so
an argmax-EV policy wins that comparison by construction — the dashboard says so in place,
and `docs/EVALUATION.md`'s "Trap 4" has the mechanism. The measured comparison lives in
`docs/RESULTS.md` ("Measured recovery, on oracle truth"). Spend, contacts, and the action
distribution on this page *are* real: arithmetic on what `decide()` actually chose, with
no draw in them.

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

## 7. The escalation queue (`/operator`)

`ESCALATE_HUMAN` produces a real work item with an owner and a deadline. The queue is
empty on a fresh instance, and that is the expected state rather than a fault — a
cost-aware policy escalates rarely, because a ₹40 human agent only clears the bar on a
large enough amount.

The reliable way to produce one is the stopping rule, which is deterministic: once
`retry_count` reaches `maxRetries`, `decide()` disallows every action except escalation
(`src/domain/decide.ts`'s `resolveAllowed`), so escalation is not merely likely, it is the
only allowed choice. Post several events for the **same** payment id at a small amount, so
the policy keeps choosing a retry action and the counter actually climbs:

```
npm run build && npm run start
npm run escalate:demo            # in another shell
```

`npm run replay` is the wrong tool here: it generates a fresh payment id per event, and
`retry_count` lives on the transaction, so the counter never climbs. `escalate:demo` posts
several signed deliveries for the *same* payment id (distinct event ids, so each is a real
delivery rather than a duplicate the idempotency guard drops) at ₹150 — small enough that
the policy keeps choosing a retry action until the cap is reached, rather than escalating
on event one. `--count`, `--amount` and `--base-url` are available.

Then open `http://localhost:3000/operator`. Expect **more work items than payments** —
once a transaction is past the cap, every subsequent delivery for it is its own escalation
decision and gets its own item, because the queue is keyed on `(event_id,
attempt_generation)` exactly as `recovery_audit` is. That is deliberate rather than
duplication: each is a distinct decision the audit trail already records separately, and
collapsing them would mean a human could not see that the system escalated twice. It does
mean an operator working a busy queue may see the same transaction more than once.

You should see:

- work items with a **reason** (`risk_gated`, `stopping_rule`, or `economic`) and a
  **deadline** — 4h, 24h and 48h respectively, a stated policy rather than a measurement,
- **Claim** — two people claiming at once is settled by the database, so exactly one wins
  and the other gets a plain "someone else has it" rather than an error,
- **Resolve** with an outcome. `Paid` marks the transaction recovered and banks the
  recovery against the customer's real history. **`Promised to pay` deliberately does
  not** — a promise is not a payment, so it leaves the transaction open and banks nothing;
  if the promise is kept, a real `payment.captured` webhook settles it once, through the
  normal path.

Resolving one is the only place in this project where an outcome comes from a person
rather than the data generator, which is why it feeds `recordCustomerOutcome` and shows up
in `prior_success_rate` and `ltv_zscore` afterwards.

Verified live rather than assumed: six signed deliveries for one payment produced five real
work items; resolve-before-claim returned `409`; two concurrent claims returned exactly one
`200` and one `409`.

## 8. The crash-recovery demo

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

## 9. The systemic-shock demo

```
npm run build && npm run start
npm run burst
```

Fires three clusters through the real signed webhook path: a 35-event main burst
sharing one (bank, errorCode) pair — comfortably over `SHOCK_THRESHOLD` — plus two
decoys named by number in BUILD_PLAN.md §6.10 (a 12-event sub-threshold cluster, and
a 35-event cluster sharing one error code spread across 4 banks, proving the shock
key is per-`(bank, errorCode)`, not per-error-code alone). Prints a detection table
(cluster, tripped, detection latency, true/false trips) and shows exactly where
`RETRY_NOW`'s own EV entry flips from `allowed: true` to `allowed: false,
disallowedReason: 'shock_suppressed'` mid-burst — the counterfactual is always on the
record (SYSTEM_SPEC.md §11), so this is the mechanism working on the actual code
path, not a number massaged to fit an illustrative example. Expect the main burst to
trip exactly once and both decoys to trip never; `process.exitCode` is non-zero if
either fails. `src/app/worker/shock-detector.ts` is the detector itself.

## Known operational notes

- **PGlite is single-connection.** Never run two processes against the same
  `.data/` directory at once — use Docker Postgres (`DATABASE_URL` set) for anything
  that needs concurrent access, including the crash-recovery demo above.
- **The tunnel must never be on the dashboard streaming path** (BUILD_PLAN.md C5) —
  record the SSE demo on `localhost`, and only use a tunnel for real webhook
  delivery (SYSTEM_SPEC.md §9, D13).
- **`.env` is never committed.** The pre-commit secret scanner blocks it either way,
  but the habit matters more than the backstop.
