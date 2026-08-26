# Incidents

A running log of things that broke, written while the detail was still fresh.

Kept for two reasons. Reconstructing an incident later loses exactly the specificity
that makes it worth reading, and the buildathon application asks what broke and how we
got out. That field is read first, so it deserves real material rather than something
assembled under deadline pressure.

Each entry records the **mechanism**, not just the symptom. "The secret scanner didn't
work" is a symptom. "I wrote BRE interval syntax and passed it to `grep -E`, where
`\{20,\}` matches a literal brace rather than a repetition count" is a mechanism.

---

## 2026-08-23 — The secret guard that silently guarded nothing

**Severity:** would have been high in a public repository. Caught before any real
credential existed, by verification rather than by luck.

### Symptom

The pre-commit hook was supposed to refuse any commit containing a credential-shaped
string. Running the D1 verification, I staged a file containing
`gsk_abcdefghijklmnopqrstuvwxyz123456`, committed it, and the commit **succeeded**. The
hook reported nothing at all. No error, no warning, no output.

### Mechanism

The hook scanned with:

```sh
patterns='rzp_live_[A-Za-z0-9]\{10,\}|gsk_[A-Za-z0-9]\{20,\}|...'
git show ":$f" | grep -qE "$patterns"
```

The interval quantifiers are written in **basic** regular expression syntax, where a
repetition count is escaped as `\{20,\}`. But the scan used `grep -E`, which is
**extended** regular expression syntax, where `{20,}` is the repetition count and
`\{` is an escaped literal brace.

So the pattern did not mean "gsk_ followed by twenty or more alphanumeric characters."
It meant "gsk_ followed by one alphanumeric character, then the literal text `{20,}`."
Nothing in any real file matches that. The pattern matched **nothing, ever**, and
`grep -q` exited non-zero, which the hook read as "clean."

Two properties made this genuinely dangerous rather than merely wrong:

1. **It failed open.** A broken pattern produced a passing result, so the guard
   reported success on exactly the input it existed to reject.
2. **It was silent.** There was no output distinguishing "scanned and found nothing"
   from "scanned nothing." A guard in this state is worse than no guard, because it
   manufactures confidence.

The same class of mistake very nearly shipped twice more while fixing it. The
replacement scanner initially skipped binary files with `text.includes('')`, which is
always true for every string, so it would have skipped every file. And an intermediate
version embedded a raw NUL byte in the source, which made git classify the scanner
itself as a binary file and stop diffing it.

### Fix

Rewrote the scan as `scripts/scan-secrets.mjs`, in Node rather than shell, with three
deliberate properties:

- **It tests itself.** Every pattern carries a `bad` example that must match and a
  `good` example that must not. `--self-test` asserts both directions and exits
  non-zero on failure. The `--staged` and `--tracked` modes run the self-test *before*
  scanning, so a clean result is only reported by a scanner that has just proved it can
  detect something.
- **One pattern list.** The pre-commit hook and the CI job both call this script, so
  they cannot drift apart. Previously the hook used BRE-in-ERE and CI used correct ERE,
  which meant CI would have caught this eventually and the hook never would.
- **It reports what it did.** `secret scan clean: 47 file(s) checked` distinguishes a
  real pass from a vacuous one. The count is the tell.

Node rather than shell also removes a quoting-and-dialect hazard on the Windows machine
this is developed on, where the hook runs under Git Bash but nothing else does.

### What it caught immediately after being fixed

A genuine false positive in `tests/unit/config.test.ts`: the test that asserts live
Razorpay keys are refused at startup necessarily contains a live-looking key literal.

The tempting fix was to allowlist the test directory. That would have been wrong, and
for an instructive reason: it would blind the scanner to a real leak in test code, which
is precisely where a developer is most likely to paste a working credential while
debugging. Instead the fixture is now assembled from parts at runtime, so the file
contains no credential-shaped literal while the test still exercises the same path. The
allowlist stays short, and every entry in it is a hole that has to earn its place.

### Verified

Four checks, all now passing:

1. `--self-test` proves all six patterns match their bad example and reject their good one.
2. `--tracked` passes on the clean tree, reporting the file count.
3. A staged file containing a Groq-shaped key **blocks the commit**.
4. Staging `.env` itself **blocks the commit**, independent of pattern matching.

### Consequence

One commit had already been created containing the probe file before the guard was
fixed. The string was a fabricated test value and never a real credential, but a
credential-shaped literal in public history is both a bad signal and something the CI
full-history scan would flag. The commit was the tip and had never been pushed, so it
was removed with a reset rather than a history rewrite. `git log --all -- leak-probe.ts`
now returns nothing.

### The lesson worth carrying forward

A guard that cannot fail is not a guard. Every check added from here needs a test that
proves it can *detect*, not merely a test that proves it passes on good input. This is
now applied in two other places: `tests/unit/purity.test.ts` asserts its own poison
harness throws before trusting the assertions that depend on it, and the idempotency
tests planned for D6 include a deliberately buggy read-then-write mode specifically to
prove the test can reproduce the race it claims to catch.

---

## 2026-08-24 — "Delete `.data/` and it rebuilds cleanly" did not, on the first real try

**Severity:** would have failed the very first clean clone with an empty `.env`, which
BUILD_PLAN.md §1.2 calls the single highest-leverage property of the repository. Caught
by running D2's own exit test rather than trusting that it would pass.

### Symptom

D2's stated exit test, verbatim from BUILD_PLAN.md's milestone table: "Deleting `.data/`
rebuilds cleanly on next boot." After wiring the PGlite adapter, the migration runner,
and auto-migrate-on-boot, `rm -rf .data && npm run dev` was run to check that line was
actually true rather than merely plausible. It was not: the very first request crashed
instrumentation with `ENOENT: no such file or directory, mkdir '.../.data/pglite'`.

### Mechanism

`PGlite.create(dataDir)` creates its own leaf directory but does not create missing
*parent* directories. `.data/pglite`'s parent is `.data/` itself. Deleting the whole
`.data/` tree — which is exactly what the exit test says to do, and exactly what a
`.gitignore`d directory invites a stranger to do without thinking about it — removes
that parent too, and PGlite's own `mkdir` call has nothing to attach to.

The bug was invisible during ordinary development because `.data/pglite` is created
once and then simply reused; only a *full* deletion of the parent, not a deletion of
the leaf, exposes it. It would have surfaced on literally the first `git clone` a
stranger tried, since a fresh clone has no `.data/` directory at all — the exact same
condition as "delete it and reboot."

### Fix

One line in `src/adapters/db/pglite.ts`, before `PGlite.create()`:
`mkdirSync(dataDir, { recursive: true })`. `{ recursive: true }` is also what makes this
safe to call on every boot, including one where the directory already exists.

### Verified

`rm -rf .data && npm run dev` from a clean tree: boot succeeds, the banner reports all
five migrations applied, `/api/health` and `/` both return 200, and a second boot
reports "database schema: up to date" rather than reapplying anything.

### A second, smaller one, found by the same instinct

Running the repository integration suite twice in a row against the Docker Postgres
target (whose volume persists across runs, unlike PGlite's throwaway temp directory)
produced a real assertion failure: a reclaim-test's `claimNext()` call returned a job
left over from an *earlier* run instead of the one the test had just created. The
`job_queue` claim query orders by `available_at` with no per-test scope — correct
production behaviour, since the queue is shared — so an older, never-completed
`claimed`-with-expired-lease row from a previous run legitimately outranked a fresh one.
Fixed by truncating the app tables at the start of each driver's suite in
`tests/integration/repositories.test.ts`, rather than relying on every future test to
clean up its own fixtures perfectly.

### The lesson, again

Both of these were "exit test says X, so run X for real" rather than "the code looks
like it should do X." Neither would have been caught by typechecking or by reasoning
about the adapter in isolation — one only appears when a *parent* directory is missing,
the other only appears on a *second* run against state that persists. The general
lesson from the secret-guard incident above keeps generalising: a claim about behaviour
that was never actually exercised is not a verified claim.

---

## 2026-08-24 — A clamp meant to guarantee an open interval quietly closed it

**Severity:** would have let `NaN` or a divide-by-zero enter the EV arithmetic for any
transaction with an extreme feature value or a confident scorer, silently — the exact
failure mode property P11 exists to rule out. Caught by running P11 itself, not by
inspecting the clamp.

### Symptom

`src/domain/scoring/logistic.ts`'s `sigmoid` clamps its input `z` to `[-40, 40]` before
exponentiating, specifically so the result can never round to exactly 0 or 1 — the
open-interval guarantee property P11 asserts and that `logit()` depends on to be
callable at all (`logit(1)` throws by design). Four tests failed immediately once P11
was written and run: two direct unit tests, one property test, and one test of
`applyActionLift`, all with the identical assertion failure `expected 1 to be less
than 1`.

### Mechanism

`sigmoid(40) = 1 / (1 + Math.exp(-40))`. `Math.exp(-40) ≈ 4.25e-18`. Float64 has about
2.22e-16 of precision around 1.0 (`Number.EPSILON`), and `4.25e-18` is roughly 50 times
smaller than that floor. `1 + 4.25e-18` therefore rounds to exactly `1.0` — not
approximately, exactly, as a matter of floating-point representability — and
`1 / 1 = 1`. The clamp that was supposed to keep the result inside `(0, 1)` was, at its
own boundary, wide enough to defeat itself: it moved `z` into a range where the *next*
floating-point operation collapsed the open interval it was meant to protect.

This is a case where the property test caught something a code reading would not: `40`
*looks* like a generous, safe margin, and nothing about the clamp's own logic is wrong.
The bug is a fact about float64's precision floor near 1.0, only visible by actually
computing the boundary value and checking whether it survived as distinct from 1.

### Fix

Lowered `Z_CLAMP` from 40 to 30. `Math.exp(-30) ≈ 9.4e-14`, comfortably above the
2.22e-16 floor, so `1 + Math.exp(-30)` is a genuinely distinct float64 value and
`sigmoid(30)` lands at `0.9999999999999906...`, strictly less than 1. The margin is now
documented in the code as a specific, checked number rather than an intuition about
what "large enough" means.

### Verified

`tests/unit/logistic.test.ts` and the P11 property test in
`tests/property/decide.property.test.ts` both assert the open-interval property at the
±1e6 feature-value extreme, which routes through the same clamp. All 141 unit and
property tests pass after the fix, including the previously-failing four.

### The lesson, again, again

A guard's own stated margin is not evidence the margin holds — the secret-guard
incident's lesson, arriving a third time in the same file that argues for it. Here the
guard was not silently absent, as in that first incident; it was present, reasoned
about, and *still* wrong at its boundary, which is arguably the more instructive
version: even a deliberate, documented safety margin needs its boundary value computed
and checked, not just asserted to be generous.

---

## 2026-08-24 — The crash demo's own trigger raced the crash it was supposed to show

**Severity:** would have made D6's crash-recovery demo non-reproducible on camera —
exactly the failure BUILD_PLAN.md §5.6 calls out `RECLAIM_CRASH_AFTER` as existing to
prevent. Caught by running the real demo sequence once before trusting it, not by
reasoning about the code.

### Symptom

The intended sequence: start the app with `DISABLE_EMBEDDED_WORKER=1` (so its own
polling loop never claims jobs), start a separate `npm run worker` with
`RECLAIM_CRASH_AFTER=intent`, POST one signed event, watch the standalone worker exit
right after committing its intent row, restart it, and confirm exactly one audit row.
On the first real attempt, the standalone worker never crashed at all — `tasklist`
showed it still running seconds later, and `/api/dev/audit-count` already showed the
event fully settled before the standalone worker had done anything.

### Mechanism

`DISABLE_EMBEDDED_WORKER` only gated the *polling* loop started from `boot.ts`. The
webhook route's `after()` self-kick (BUILD_PLAN.md §5.7 trigger 3) is separate code,
in a different file, with no flag check of its own — and it fires within milliseconds
of the response being sent, versus the standalone worker's 250ms poll interval. Every
single time, the app's own request-handling process claimed and fully settled the job
before the standalone worker's next poll even ran. The flag's name promised "disable
the embedded worker"; the code only disabled one of the two triggers that could act as
one.

### Fix

Gated the `after()` kick in `app/api/webhooks/razorpay/route.ts` on the same
`DISABLE_EMBEDDED_WORKER` flag. One `if` around the existing `after(...)` call.

### Verified

Re-ran the full sequence for real: server with the flag set, standalone worker with
`RECLAIM_CRASH_AFTER=intent`, one signed POST. `tasklist` confirmed the worker process
was gone immediately after; `/api/dev/audit-count` read `0` (T3 committed, T4 never
ran — exactly the crash matrix's hardest row). Restarted the worker; it sat idle until
the 30-second lease actually expired, then reclaimed the same job on its next poll and
settled it. Final count: `1`. `tests/integration/webhook-worker.test.ts` also exercises
this same reclaim path with a stubbed `process.exit`, so the logic is covered without
depending on a real process kill on every CI run — but the real run is what caught the
bug the stubbed version couldn't, because the stubbed test drives `processEvent`
directly and has no second trigger to race against.

### The lesson

A flag that disables "the worker" needs an inventory of everything that can act as a
worker, not just the one the name brings to mind first. BUILD_PLAN.md §5.7 itself lists
four triggers precisely because they are easy to enumerate on paper and easy to
under-count in code — this is what under-counting them looks like in practice.

## 2026-08-25 — The stopping rule was fully correct and completely inert

**Severity:** SYSTEM_SPEC.md §14's own invariant ("at most 3 automated attempts") could
never actually fire on the live path, for every transaction, since D2. Caught while
building D11's shock detector, not by a failing test — nothing exercised the live
worker's retry-count wiring closely enough to notice it was a no-op.

### Symptom

`decide()`'s stopping rule (`input.retryCount >= policy.maxRetries`, `src/domain/decide.ts`)
is correct and property-tested (P3). `transactions.repo.ts`'s `incrementRetryCount`
existed since D2's very first migration. Neither was the problem. The problem: nothing
in `src/app/worker/process-event.ts` ever *called* `incrementRetryCount`. Every
transaction's `retry_count` column sat at `0` forever, no matter how many
`RETRY_NOW`/`RETRY_LATER` decisions it accumulated — `retryIndex` was read from the
stored count on every call, never advanced after one.

### Mechanism

`retryIndex = existingTxn?.retryCount ?? 0` (line 100, unchanged since D6) reads the
count; nothing downstream writes it back. The T4 settle transaction persisted the
audit row, the action-attempt intent, the batch counters, and the job completion — but
never the one write that would have let the *next* event about the same transaction
see a higher count. A transaction could receive an unlimited number of `RETRY_LATER`
decisions in a row and never once trip the stopping rule, because from `decide()`'s
point of view every single call looked like the first attempt.

### Fix

One call, inside the existing T4 transaction, gated on the chosen action:
```ts
if (decision.chosenAction === 'RETRY_NOW' || decision.chosenAction === 'RETRY_LATER') {
  await transactionsRepo.incrementRetryCount(tx, txnId)
}
```

### Verified

Ran `npm run burst` (82 synthetic events) against real Docker Postgres and queried
`max(retry_count)` across every transaction in the database afterward: `1`, as expected
for single-attempt synthetic events, and genuinely nonzero — confirming the column now
advances at all, which it provably could not have before this fix regardless of how
many events any transaction received.

### The lesson

A repository function existing, being correctly implemented, and being covered by
nothing is indistinguishable from dead code until something goes looking for its
caller. `grep -rn incrementRetryCount src/` before this fix returned exactly one
result: its own definition. That is the check that would have caught this on D6, and
the one worth running on any function whose only test is that it compiles.

## 2026-08-25 — A PR-AUC test that expected the right answer caught the wrong one

**Severity:** would have shipped a PR-AUC number roughly 30% lower than the real one
(0.161 reported instead of 0.204) in the risk gate's own evaluation — not a crash, but
exactly the kind of quietly-wrong number BUILD_PLAN.md §6.11 exists to prevent. Caught
by a test whose expected value (1.0, for a perfectly-separating toy case) was easy to
state and impossible to fudge, not by inspecting the real data's output for
plausibility.

### Symptom

`scripts/data/risk_eval.py`'s first `pr_curve` implementation swept an arbitrary
threshold grid — every observed score plus synthetic `0.0`/`1.0` endpoints — and
sorted the resulting points by recall alone before trapezoidal integration.
`eval/test_risk_eval.py::test_pr_auc_is_perfect_for_a_perfectly_separating_score`
built a trivial 4-point case where every positive scores above every negative, where
the answer has to be exactly `1.0` by definition, and got `0.875`.

### Mechanism

Once recall has already reached `1.0` (every positive already flagged), sweeping the
threshold lower keeps sweeping in more negatives — recall stays at `1.0` but precision
keeps falling. Sorting by recall alone left every one of those tied-recall points in
threshold order, not precision order, so the integration's very first step at
`recall=1.0` landed on the *lowest* remaining precision in the tie group rather than
the highest, undercounting the area for exactly the region where the score is most
informative.

### Fix

Replaced the threshold-grid sweep with the standard rank-based construction (the same
one `sklearn.metrics.precision_recall_curve` uses): sort by score descending, and
accumulate `tp`/`fp` one score-tied group at a time. Recall is non-decreasing by
construction — there is no way for the curve to double back — and precision is
well-defined pointwise at each step, so there is no tie-breaking sort to get wrong.

### Verified

The 4-point perfect-separation case now returns exactly `1.0`. Rerunning
`npm run risk:eval` against the real `risk_eval_demo.csv` moved the reported PR-AUC
from 0.161 to 0.204 — the number now committed in `docs/risk_eval_results.json` and
`docs/EVALUATION.md`'s D11 section is the corrected one.

### The lesson

A test whose expected value comes from a definition ("perfect separation must score
exactly 1.0") is worth more than ten tests whose expected value comes from running the
code once and copying its output — the former can catch the code being wrong, and the
latter definitionally cannot. This is the same principle BUILD_PLAN.md §6.8 states for
the Python/TypeScript parity contract, applied to a metric instead of a model.

## 2026-08-26 — The customer-id fallback searched the wrong column

**Severity:** would have made `cardVelocityHigh`/`cardFirstSeenRecently` permanently
`false` for every non-card payment method (netbanking, UPI) — silently, since the code
ran without error and simply always found zero matches. Caught by the integration test
written for this exact fallback path, on its very first run, before this ever reached a
committed state.

### Symptom

`buildLiveRiskSignals` (`src/app/worker/live-risk-signals.ts`, written today to close
the D11 TODO on real risk signals) computes a "risk identity key" as `cardId ??
customerId`, so a UPI/netbanking payment — which never carries a `card_id` — still gets
tracked by its `customer_id` instead. The first version of the two repository query
functions it called (`countRecentFailedByCardId`, `earliestTransactionMsByCardId`) took
that key and always searched the `card_id` column with it, regardless of which kind of
identity the key actually was. `tests/integration/live-risk-signals.test.ts`'s
"falls back to the customer id... (netbanking/UPI)" test — three failed transactions on
the same customer, no card id at all — expected `cardVelocityHigh: true` and got `false`.

### Mechanism

The function signatures (`cardId: string`) named the parameter after the common case
and the SQL (`WHERE card_id = $1`) matched that name, but the actual value passed at the
call site could be a customer id instead, per `buildLiveRiskSignals`'s own fallback
logic. Nothing in the type system caught this — a `string` is a `string` regardless of
which column it is meant to match against, and the query ran successfully every time; it
just matched nothing, since a customer id was never going to equal any `card_id` value in
the table. A silently-always-empty result set looks identical to "genuinely no history,"
which is exactly why `cardFirstSeenRecently` defaulting to `true` in that case (the code
treats no-history as first-seen) would have made this specific bug even harder to notice
by symptom alone — a UPI payer's *tenth* transaction would still have read as brand new.

### Fix

Replaced the single ambiguous `cardId` parameter with an explicit
`RiskIdentityColumn` (`'card_id' | 'customer_id'`) alongside the key, so the caller states
which column a given key is meant to match rather than the query assuming. `buildLiveRiskSignals`
now returns `{ column, key }` from its own identity-resolution step, and both repository
functions search whichever column is named.

### Verified

`tests/integration/live-risk-signals.test.ts`'s fallback test passes: three failed
netbanking-style transactions (no card id) sharing one customer id, then a fourth
transaction under the same customer id, correctly reads `cardVelocityHigh: true`.
Confirmed live against a real running server, too — a hand-crafted probe (webhook events
sharing one card id, and separately one sharing only a customer id) tripped both
`cardVelocityHigh` and `amountFarAboveHistory` for real, forcing `ESCALATE_HUMAN` through
the actual risk gate on live traffic for the first time in this project — not the
simulator, not a hand-crafted `decide()` call, the real webhook path.

### The lesson

A parameter named after the common case invites a caller to pass the uncommon case into
it without anything complaining — the type system will happily accept a customer id where
a card id was expected, because both are just strings. Naming the *column* explicitly as
its own typed value, rather than trusting a same-shaped string to mean the right thing,
is what actually closes that gap; a docstring saying "this searches by card id" is not
a substitute for the query being unable to search anything else by accident.

## 2026-08-26 — A demo batch that was 100% ESCALATE_HUMAN, the day after the risk gate started working

**Severity:** would have made the D9 dashboard demo — "click Run batch, watch a
realistic decision mix render" — show every single decision escalating to a human,
with no visible variety at all. Caught while gathering real numbers for the D13
README, by running the exact demo path a reviewer would.

### Symptom

A fresh 300-event batch, run to pull real, live numbers for the README's Results
section, came back with `countByAction: { ESCALATE_HUMAN: 300 }` — every decision, no
exceptions. A 60-event batch run minutes earlier had shown a normal, varied mix
(`RETRY_LATER: 35, PAYMENT_LINK: 10, ESCALATE_HUMAN: 15`), so this was not the model's
own behaviour — something about the larger batch specifically was different.

### Mechanism

`src/app/batch/synthetic-events.ts` generated every synthetic event's `customer_id` as
`cust_batch_${i % 15}` — the same 15 ids, reused identically across *every batch this
session had ever run*, not scoped to the batch that generated them. That was harmless
while `cardVelocityHigh`/`cardFirstSeenRecently` (`src/app/worker/live-risk-signals.ts`,
built the day before to close the D11 TODO) were still hardcoded to `false` everywhere
they were read. The moment those signals started reading real transaction history, the
same 15 reused customer ids — by then carrying dozens of accumulated failed
transactions each, from every prior batch and every prior probe run that same
session — meant `cardVelocityHigh` was already `true` on the very first event of any
new batch. The risk gate was not malfunctioning; it was correctly detecting a real
burst of same-customer failures. The burst just happened to be an artifact of the demo
data's own reused identity scheme, not a signal about anything actually risky.

### Fix

Every synthetic batch event now gets its own fresh, batch-scoped customer id
(`cust_batch_<batchId>_<i>`), so no id is ever reused within one batch or across two
different batches.

### Verified

`tests/unit/synthetic-events.test.ts` checks both properties directly (40 events in one
batch produce 40 distinct customer ids; two different batches never share an id).
Re-ran the identical 300-event batch after the fix: a real, varied distribution again
(220 retry-later, 80 payment-link, zero escalations) — the exact numbers the README's
Results section now quotes.

### The lesson

A fix that makes a signal genuinely real can break a demo that was quietly depending on
that signal always being inert. The bug here was not in the new risk-signal code at
all — it behaved exactly as designed — it was in a completely different, unrelated file
whose own design had never had to account for real risk detection existing. Shipping a
feature that changes what "realistic" data needs to look like is worth a pass over
every fixture and generator that produces that kind of data, not just the code path the
feature itself touches.

## 2026-08-26 — `decide()` still runs on a payment that just succeeded

**Severity:** low, real, and only discoverable once a genuine `payment.captured`
delivery ever reached this system — which, until this same day, had never happened. Not
a defect that changed any stored outcome incorrectly; a design gap in what a
`recovery_audit` row means for a captured event.

### Symptom

A real ₹100 test-mode payment (`pay_TUT6SjUbB46C9u`) was paid to completion through a
real Payment Link, producing two genuine, Razorpay-signed webhook deliveries in
sequence: `payment.authorized`, then `payment.captured`. Both verified, both ingested,
both ran the full `processEvent` pipeline. The second one correctly set
`transactions.status = 'recovered'` — but `recovery_audit` shows `decide()` computed a
fresh EV-based decision for it anyway (`RETRY_LATER`), exactly as if it were still a
failed payment. The audit trail for a transaction that just succeeded contains a
recommendation to retry it later.

### Mechanism

`processEvent` (`src/app/worker/process-event.ts`) derives `status` from the event type
and writes it via `upsertTransaction` early in the function, correctly. It then runs
`decide()` unconditionally, regardless of what `status` was just set to — there is no
branch that says "this event represents a success, skip the recovery decision." That
was never wrong for this project's only tested case until today (every real and
simulated delivery before this one was a `payment.failed` event), so the gap was never
visible.

Because `resolveExecutionMode` still resolved `dry_run` (`EXECUTOR_MODE` was never set
to `live`), `settle()`'s outcome was `'pending'`, which is `!== 'success'` —
`scheduleFollowupRetry` (added earlier this same day) ran its normal path and scheduled
a real future re-evaluation job against this already-recovered transaction.

### Why this did not become a real bug

This is exactly the scenario `process-event.ts`'s `isFollowup` guard was built for,
earlier the same day, for a different reason (a real webhook independently recovering a
transaction while a stale follow-up was still in flight) — it checks the transaction's
*current* status before letting a follow-up job overwrite anything, and skips cleanly
if it is already `'recovered'`. The guard exists and is tested
(`tests/integration/retry-followup.test.ts`); this incident is the first time the exact
condition it defends against arose from genuinely live traffic rather than a
hand-constructed test, and it held.

### Update — closed the same day, not left for the next session

`process-event.ts` now short-circuits immediately after `upsertTransaction` whenever
`status === 'recovered'`: no `buildLiveFeatures`, no `buildLiveRiskSignals`, no
`decide()`, no executor call, and no `recovery_audit` row at all — there is genuinely
nothing to decide once a payment has captured, so the honest choice is to write no
decision rather than a real-but-misleading one. The real customer outcome (the reason
this signal exists at all) is still recorded, inside its own small transaction, guarded
the identical "first time only" way T4's own version of this check already was.
Verified directly: `tests/integration/retry-followup.test.ts`'s "a payment.captured
delivery short-circuits before decide() ever runs, and still records the real customer
outcome" — zero audit rows for the captured event, transaction status `'recovered'`,
and `customers.successful_payments`/`ltv_amount_paise` both real and updated.

### The lesson

A code path can be entirely correct for every case it has ever actually been exercised
against and still have a real gap for the one case nobody could exercise until real
credentials and a real payment existed. The defense that happened to already be in
place (`isFollowup`) was built for a different, related reason — proof that designing
guards around *invariants* ("never let a stale decision overwrite a resolved one")
rather than around the one scenario in front of you at the time pays off in cases you
did not anticipate.

## 2026-08-27 — `retry_count` could be raced past the stopping rule's own cap

**Severity:** real, found live against the real Supabase deployment, not a unit-test
construction. Bounded blast radius — the stopping rule (SYSTEM_SPEC.md §14: "at most 3
automated attempts") could be overshot by a small, race-dependent margin, never
unbounded, and no money or customer contact was ever at stake, since every action this
project's live executor can reach is either `dry_run` or, for the one action with a
real gateway call, gated separately by its own live-budget check.

### Symptom

Sent four real, signed webhook deliveries for the same synthetic transaction in quick
succession, verifying `src/app/worker/live-features.ts`'s new customer-outcome wiring.
`transactions.retry_count` ended at `4` — past `SUBSCRIPTION_DEFAULT_POLICY.maxRetries`
(3) — and the fourth event still chose `RETRY_LATER`, when `decide()`'s own stopping
rule should have forced `ESCALATE_HUMAN` once `retryCount >= maxRetries`.

### Mechanism

`processEvent` reads a transaction's current `retryCount` early, with no transaction
open, computes a decision from it, and only increments the stored value much later, in
the T4 transaction — a real gap between "read" and "write" that spans an entire
decision pipeline (feature queries, `decide()`, the executor call). Under strictly
sequential processing this is fine. It is not fine under *concurrent* processing of the
same transaction, which is genuinely possible: every webhook POST kicks a non-blocking
`after()` drain, the embedded poller ticks independently, and neither is aware of the
other. Two concurrent `processEvent` calls for the same transaction can both read the
same pre-increment `retryCount`, both conclude the stopping rule has not fired yet, and
both commit — each pushing the counter up by one, together overshooting the cap by
however many callers raced it.

### Fix

`transactions.repo.ts`'s `incrementRetryCount` now takes a required `cap` and enforces
it as one atomic, self-limiting SQL statement — `UPDATE ... SET retry_count =
retry_count + 1 WHERE id = $1 AND retry_count < $2` — rather than a plain increment a
caller was trusted to check before calling. The `WHERE` clause is what makes this
correct under real concurrency: once the cap is reached, every further concurrent
caller's `UPDATE` simply matches zero rows and returns the real current value instead,
regardless of what stale value any of them read earlier. No application-level
check-then-act, no lock held across a network call — the database enforces its own
invariant in the one statement that mutates it.

### Verified

`tests/integration/repositories.test.ts`'s "caps retry_count atomically under genuine
concurrent callers, not just sequential ones" fires 20 real concurrent
`incrementRetryCount` calls via `Promise.all` (not a sequential loop, which would never
have caught this — sequential calls cannot race) against both PGlite and the real
Supabase deployment where the original race was actually found, and asserts the stored
value never exceeds the cap.

### Not fully closed, stated plainly

The counter is now correctly capped, but the *decision* a racing caller computed was
still made from a stale `retryCount` read before the fix — under the same race, two
concurrent calls could still both choose `RETRY_NOW`/`RETRY_LATER` and both write a
`recovery_audit` row recommending further action, one commit after the cap was already
reached. `decide()` re-running with fresh data mid-pipeline, or a full re-read
immediately before commit, would close that too, and was not built today because it
requires either holding a lock across the network calls this codebase's own
architecture deliberately avoids, or a genuine redesign of where the stopping-rule
check happens — worth doing, not rushed.

### The lesson

A correctness invariant that spans multiple statements across an entire pipeline is
only as strong as its narrowest atomic operation — and "narrowest atomic operation"
was, until this fix, "none at all": the increment was one statement, but the decision
that justified making it spanned the whole function. Moving the cap into the mutating
statement itself, rather than trusting whoever calls it to have checked first, is the
same principle `kv.ts`'s `incrWithTtl` and this project's idempotency-via-UNIQUE-
constraint design already hold to elsewhere — re-derived here the hard way, by actually
sending real concurrent traffic at a real deployment rather than assuming sequential
processing because that is what every prior test happened to exercise.
