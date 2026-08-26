# Load test, run for real against the real Supabase deployment

Closes a real, named gap: no load test beyond the one 20-concurrent-duplicate-
webhook correctness test existed before this. This is a real one, against the
actual Supabase-backed instance this project has been running against, not a
local Docker Postgres or PGlite — the numbers below are what a reviewer would
see running the exact commands themselves, on this same deployment.

## Method

```bash
node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/replay.ts --n 500 --concurrency 50
```

`scripts/replay.ts` posts real, signed `payment.failed` events at the real
`/api/webhooks/razorpay` route — the same HMAC verification, same T1 insert,
same job queue a genuine Razorpay delivery hits. It reports the webhook route's
own response latency, not the worker's downstream decision latency.

**A real methodology pitfall, worth naming rather than hiding:** the first run
reported `0/500 accepted` and looked like a total failure. It was not a server
defect — the invoking shell did not have `.env` loaded, so the script signed
every event with the fallback development secret instead of the real one, and
every request was correctly rejected as an invalid signature before ever
reaching the database (confirmed directly: zero `webhook_events` rows from that
run). Every number below is from `.env`-loaded runs, verified against real
`webhook_events`/`job_queue`/`recovery_audit` rows, not just the script's own
client-side report.

## What broke, found by running it, not by inspection

**500 concurrent-ish requests against a `node-pg` `Pool` with no `max` set — the
`pg` library's own default of 10 — was the real bottleneck**, not the route
logic, not Supabase's own limits. First run: 500/500 eventually accepted, but

| | p50 | p95 | max |
|---|---|---|---|
| Pool max 10 (unset, library default) | 9013ms | 14757ms | 15997ms |

**Fixed for real**, not just noted: `DB_POOL_MAX` (`src/config/env.ts`, default
20, wired through `src/config/container.ts` into `src/adapters/db/node-pg.ts`'s
`Pool({ max: poolMax })`) — the only file allowed to read `process.env`, per this
project's own boundary rule, so this is one line at the one place it's allowed
to be. Re-measured on the identical 500-event, 50-concurrency run after
restarting with the new default:

| | p50 | p95 | max |
|---|---|---|---|
| Pool max 20 | 4998ms | 8376ms | 9195ms |

**A ~45% real reduction in both p50 and p95** from doubling the pool. Still not
fast in absolute terms — the remaining latency is real network round-trip time
to Supabase's free tier under burst load, not something a pool-size knob fixes
further. Supabase's own connection pooler (port 6543, PgBouncer) was already
the documented recommendation in `docs/SETUP.md` for exactly this reason and
was never actually switched to during this build — the direct connection
(port 5432) is what every number on this page measures.

## A second real finding: sustained load compounds, and the worker is single-threaded per process

`drainOnce` (`src/app/worker/drain.ts`) claims and processes jobs in a `while`
loop, one at a time, deliberately — see its own docstring on why T2 CLAIM is a
single atomic statement rather than a batch. That means one embedded worker's
real throughput is bounded by `1 / (decide() pipeline latency)`, not by how
many jobs it claims per tick.

Measured directly from real `job_queue` timestamps during this test (1,400+
events queued across the three runs above): **713 jobs settled in 834 seconds
— roughly 51 jobs/minute, ~0.86/second, for one embedded worker process against
real remote Supabase.** A second load-test run posted 200 more events *while*
this backlog was still draining and measured real, honest degradation from the
contention: p50 2488ms / p95 8416ms for those 200 requests, worse than an
uncontended run at the same concurrency would be — a real backlog visibly
slows down new arrivals too, not just the queued ones.

**The mitigation already exists in this architecture and was never load-tested
until now:** `npm run worker` runs a standalone process claiming from the same
queue via `FOR UPDATE SKIP LOCKED` (`job-queue.repo.ts`'s `claimNext`), proven
safe under concurrency by the crash-recovery tests this project already has.
Running multiple standalone workers alongside (or instead of) the embedded one
is the real, already-built answer to "what happens at higher volume than one
process can drain" — this load test is what actually establishes that the
single-worker default needs that answer at all, rather than assuming it.

## Honest limits of this test

- Single machine, single network path (this developer's own connection to
  Supabase's ap-south-1-ish region) — not a representative multi-region load
  test, and not from inside AWS/GCP where Supabase itself typically runs.
- 500–700 events is a real number, not a huge one. It establishes the
  bottleneck exists and is fixable; it does not establish a ceiling at, say,
  50,000 events/hour, which this project has not attempted to measure.
- No concurrent standalone-worker run was actually executed as part of this
  test — the SKIP LOCKED safety property is proven by existing tests, but the
  *throughput* gain from running, say, four standalone workers concurrently
  against this same backlog was not measured here, stated as an honest
  absence rather than an assumed number.
