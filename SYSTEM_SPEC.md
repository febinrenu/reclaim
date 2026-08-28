# Reclaim — Risk-Aware Revenue Recovery Engine
### Full build specification for the Razorpay AI Buildathon (Track 03: AI Revenue Recovery)

This is the build brief this project was implemented against. It contains the verified program rules, the full product design and architecture, the exact data model, a milestone build plan, and the demo/submission checklist. Every technical choice runs on free-tier infrastructure and a normal laptop — nothing here requires a GPU, a card on file, or a team.

**Project name used throughout:** `Reclaim`. Placeholder — check GitHub name availability and swap freely. Alternatives: `Recoup`, `Ledger Sentinel`, `Backstop`.

---

## 0. Read this first

**The deadline is a fact, not a design constraint.** As of writing (22 Aug 2026), the Razorpay AI Buildathon application closes **5 September 2026**. That's stated once, here, so you can plan around it — this document no longer scopes the build *down* to fit the calendar. It scopes the build to be **correct, tested, and defensible**, and gives you a milestone order rather than a countdown. If you end up with time to spare, §16, §18, and §25 are not decoration — build them.

**What changed from the previous version of this spec:** that draft was scoped to survive a tight 13-day panic. This one assumes you have the runway to do it properly, and it adds exactly the things a real reviewer would ask about that a rushed version would skip: automated tests, a calibration check on the probability model (not just "it works on my demo data"), a precision/recall table on the risk gate, replay-attack protection on the webhook, latency and cost instrumentation, a second scenario proving the engine isn't hardcoded to one story, and a section written from the other side of the table — what we'd actually be looking for if we were reading your repo.

**How to use this:** work top to bottom, one section at a time. Run and inspect each layer before stacking the next one on it — a system you understand beats a system you assembled.

---

## 1. The Buildathon — verified facts

Pulled directly from `razorpay.com/buildathon` on 22 Aug 2026. Re-check the live page before you submit in case anything changes — treat this section as a snapshot, not a permanent record.

**The offer:** ₹75,000/month stipend · 6 or 12 months, your choice · in-person, Bangalore, from September. Shortlisted builders go straight to a panel interview — no aptitude test, no group discussion.

**The application form asks for exactly 12 things:**

*About you:* Full name · College · Graduation year · In-person from September (yes/no) · 6 or 12 months (your pick) · Resume file.

*About the build:* Your track · Project name · What it solves · GitHub repo URL (must be public) · 5-minute pitch video (unlisted is fine) · **What broke, and how you got out.**

Razorpay's own words: *"We still take the resume. We just don't screen on it. The last one is the one we read first."* — your failure story is the first thing read, not a footnote. §22 and §26 build that story on purpose.

**What they judge, verbatim:**

| Criterion | What it means |
|---|---|
| Problem taste | Did you pick something that actually matters |
| Build quality | Does it run, is it structured, would you trust it |
| AI judgment | The right tool in the right place, and where you chose *not* to use one |
| Failure recovery | What broke, and what you did about it |

**Track 03 — AI Revenue Recovery** (the track this spec targets): *"Find revenue that's slipping away and win it back. Build an agent that detects revenue at risk, determines the right intervention, and executes a bounded recovery workflow: from payment failures and checkout abandonment to overdue receivables."* Its bar, verbatim: **"Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."**

Example directions listed: payment degradation → root cause → recovery action, checkout drop-off recovery, failed-subscription recovery, **B2B receivables chaser**, mandate retry sequencer, **Hinglish voice/message recovery**, promise-to-pay tracker. This spec builds the first, third, and sixth together as the primary scenario, and adds the B2B receivables chaser as a second scenario in §16 specifically to prove the engine generalizes.

**Track 02 — AI Risk Manager** (referenced, not the submission track): *"Build a working detector, verifier or auto-responder for one class of loss, with measured precision and recall on a held-out test set."* Bar: *"Honest metrics including false-positive cost. Strictly defense-only: anything offense-capable is disqualified."* **The form has a single "Your track" field — submit under Track 03.** Hold Track 02's rigor (precision/recall on a held-out set, honest false-positive cost) as an internal discipline for the risk gate anyway — it costs one afternoon and it's exactly the kind of depth a reviewer with a risk background will specifically go looking for and be pleasantly surprised to find.

---

## 2. Reading this like a Razorpay reviewer would

You asked me to put myself on the other side of the table. Here's how I'd actually go through a submission like this one, in the order I'd actually do it, if I were on the panel.

**First move: I open the GitHub repo, not the video.** The video is the pitch; the repo is the evidence. If the repo doesn't load, has no README, or `git clone && npm install` fails on a machine that isn't yours, I've already formed an opinion before I've watched a single frame of your video. This is the single highest-leverage thing you can get right: **make the zero-context path work.** Someone who has never spoken to you should be able to clone it, follow the README, and have it running in under ten minutes. If that's not true, fix that before you polish anything else.

**Second move: I check the commit history, not just the final diff.** `git log --oneline --stat` tells me whether this was built over two weeks or assembled in one sitting the night before the deadline. Both can produce the same final code, but they don't read the same way. A history that shows a webhook route landing, then tests for it, then the decision engine landing on top, then a bug fix with a commit message that says what broke — that's a person who operated the thing they built. One giant commit dated September 4th reads as "I generated this." Commit early, commit often, write real commit messages. This costs nothing and is worth more than almost any single feature you could add instead.

**Third move: I read "what broke, and how you got out" before I read your README.** You told me that's what happens, and I believe it, because it's the fastest way to tell a real builder from a good pitch-writer. I'm specifically listening for: was the bug *in your system*, described in terms specific enough that I believe you actually hit it? "I ran out of time" is not a bug. "The webhook secret used to sign the payload and the one my server was verifying against were pulled from different env files after I switched Supabase projects, and the failure mode was silent — every webhook returned 400 and I didn't have logging on the rejection path, so it looked like Razorpay wasn't calling my endpoint at all" is a bug. Specificity is the tell. §22 (Day-of-testing) exists to manufacture a real one instead of leaving you to invent one under pressure.

**Fourth move: I look for where you *didn't* use AI.** This is the part of "AI judgment" people miss most often, because the instinct under time pressure is to reach for an LLM everywhere it's plausible, since it's fast to wire up. I am specifically checking whether your money-math, your retry counters, your stopping rules, and your API calls to Razorpay are deterministic code I could unit-test — or whether an LLM is anywhere in a path that ends in an API call that moves money or state. If I find a prompt that says "decide whether to retry this payment" and its output is parsed and acted on directly, that's a red flag in a fintech context, not a green one, regardless of how good your prompt engineering is. If instead I find a clean seam — a rule-based or statistical decision, with the LLM confined to writing the sentence that explains the decision or drafting a customer-facing message — that's exactly the "right tool, right place, and where you chose not to use one" the rubric names. Say this explicitly in your README; don't make me infer it, but also don't just *claim* it — I will grep for it.

**Fifth move: I stress-test your numbers.** "Recovery rate: 36%" tells me nothing on its own. I want to know: recovered out of how many, over what amount, compared to what baseline (what would a naive retry-everything system have recovered, and at what cost)? If your `DO_NOTHING` bucket is empty, I assume your expected-value math never actually produces a negative number, which means it isn't really doing anything the naive version wouldn't. If your risk gate's precision is 100% and recall is 100%, I assume it was evaluated on the same data it was tuned on, not a held-out set, and I will ask about class balance. Show your work: how many held-out cases, how many positives, what the naive baseline would have scored. Honest, unglamorous numbers you can defend beat a single impressive-sounding percentage every time.

**Sixth move: I watch the video for what's actually running, not what's narrated.** A slide with a nice architecture diagram and a voiceover saying "the system detects fraud and recovers revenue" tells me you can explain your idea. A terminal window where I watch a batch run, numbers land in a dashboard in real time, and then you kill the process mid-batch and restart it to show nothing double-fires — that tells me you built something. If your five minutes are mostly slides, you've spent your best evidence on the weakest format.

**Red flags that specifically sink a submission, from where I sit:**
- An `.env` file committed with live keys (also just genuinely dangerous — rotate them immediately if this happens).
- Metrics with no stated methodology or held-out split.
- "AI-powered" language with no explanation of what the AI actually does versus what's deterministic.
- A demo video with no live execution — only slides and screenshots.
- Zero tests, no error handling visible anywhere, one 800-line file called `index.js`.
- A failure story that isn't really a failure ("I didn't have enough time to add X" is a scope note, not an incident).

**What actually gets a "call them in":**
- It runs, from a stranger's clone, first try, using the README alone.
- The AI/non-AI split is a real seam in the code, and the README states it in one sentence I can verify.
- The numbers are specific, held-out, and compared to a baseline.
- The failure story is technical, specific, and shows you can debug under uncertainty — not just that something eventually worked.
- There's evidence of iteration (commit history, a test suite, an ADR explaining a tradeoff) rather than a single polished artifact with nothing behind it.

Every section from here down exists to make each of those six moves land in your favor.

---

## 3. The product concept, in one paragraph

Most "AI payment recovery" demos predict whether a payment will fail. That's necessary but not the interesting part. Reclaim asks a different question: **given a payment already failed, is it worth spending money and risk to get it back — and if so, how?** Every recovery action costs something (an SMS, a support agent's time, the risk of behavior that reads as harassment or fraud-adjacent) and every rupee spent chasing a payment that was never coming back is a rupee that should have gone elsewhere. Reclaim treats recovery as a constrained optimization problem, not a retry loop, and it is explicitly allowed to do nothing. That's the whole pitch, and every section below exists to make it true in working, tested code — not just in a README.

---

## 4. The decision model

For a failed payment in state `s`, and for each available action `a` in `{RETRY_NOW, RETRY_LATER, PAYMENT_LINK, WHATSAPP_NUDGE, ESCALATE_HUMAN, DO_NOTHING}`:

```
EV(a) = P(recover | s, a) × RecoverableAmount
        − InterventionCost(a)
        − ComputeCost(a)
        − RiskPenalty(s, a)
```

Choose `a* = argmax EV(a)` across allowed actions. `DO_NOTHING` always has `EV = 0` by definition — the reference point, not a fallback. If nothing else beats zero, the system does nothing and logs why.

- **P(recover | s, a)** — output of the recovery scorer (§10), a calibrated probability, not a raw model score. "Calibrated" is doing real work in that sentence — see §10's reliability check. A model that ranks correctly but outputs 0.9 when the true rate is 0.4 will make your EV math confidently wrong.
- **RecoverableAmount** — the failed payment's amount, in rupees.
- **InterventionCost(a)** — a small, documented cost table: an SMS/WhatsApp nudge ≈ ₹0.35, a support escalation ≈ ₹40 in agent time, a silent retry ≈ ₹0. State your assumptions in the README; a reviewer will accept a defensible estimate and reject an unexplained one.
- **ComputeCost(a)** — real cost, not fiction: the actual dollar cost of the action's LLM call, computed from tokens used × Groq's published per-token price (§12), converted to INR. You're on the free tier so nothing is actually billed — logging the *true* unit economics of the call you would have paid for is the stronger signal, because a reviewer can check your arithmetic against Groq's public pricing page.
- **RiskPenalty(s, a)** — output of the risk gate (§11). Zero for low-risk transactions, large and negative for flagged ones, which naturally pushes the argmax toward `ESCALATE_HUMAN` without needing special-case branching.

### 4.1 Calibration: proving P(recover) means what you say it means

A probability that isn't calibrated is a decoration. Before you trust the scorer inside the EV formula, run this check and put the result in your README:

1. On the held-out batch, bucket predictions into deciles (0.0–0.1, 0.1–0.2, …).
2. For each bucket, compute the actual observed recovery rate.
3. Plot predicted-probability-bucket against observed-rate. A well-calibrated model sits close to the diagonal.
4. Report the **Brier score** (mean squared error between predicted probability and the 0/1 outcome) as a single number alongside the plot.

This is a ten-line script and a five-minute chart, and it is exactly the kind of rigor that separates "we called `model.predict_proba()` and moved on" from "we understand what our number means." It also gives you a legitimate, specific thing to say when a reviewer asks "how do you know 0.7 really means 70%?"

---

## 5. What AI does, what it doesn't, and what we rejected

| Layer | Tool | Responsibility |
|---|---|---|
| State transitions, retry limits, money math, the EV formula, idempotency, policy enforcement, audit logging, all Razorpay API calls | **Plain TypeScript, unit-tested** | Anything where being wrong costs money or trust. Deterministic, no model in the loop, ever. |
| P(recover \| s, a) | **Logistic regression**, trained offline on synthetic history, calibration-checked (§4.1) | A calibrated probability. Chosen over a heavier model on purpose — see below. |
| Drafting the recovery message, explaining *why* an action was chosen, handling ambiguous free-text failure reasons | **Groq-hosted LLM** (§12) | Language tasks only. Never touches a number that affects money movement. No reference to the Razorpay client anywhere in its call scope — not policy, a structural fact about the code. |

**Alternatives we considered and rejected, and why** — this table is worth including verbatim in your README, because it directly answers "where you chose not to use one":

| Option | Why not |
|---|---|
| XGBoost for the recovery scorer | More predictive power than logistic regression on paper, but needs somewhere to run inference. The obvious free host for a small Python service (Hugging Face Spaces on a personal account) now requires a paid plan to create a Docker/Gradio Space — verified while researching this spec. A network hop to a second service is also a new failure mode in a recorded, one-shot demo. Logistic regression runs in-process, in under a millisecond, and is fully explainable on camera. If time allows, §25's ADR documents a real side-by-side comparison instead of asserting one is better. |
| One LLM call that decides everything (score, risk, and action, in one prompt) | Fast to build, impossible to audit, and puts a non-deterministic component directly upstream of a money-moving action. This is the exact failure mode Track 02's "strictly defense-only" and Track 03's "audit trail" language are both implicitly warning against. |
| Fine-tuning a model on synthetic data | Unnecessary complexity for a system whose core decision is a handful of numeric features — a fine-tuned model would be less interpretable than logistic regression for no accuracy benefit at this data scale, and fine-tuning infrastructure is exactly the kind of scope that eats a week without moving the rubric. |
| A rules-only system, no ML at all | Would satisfy "AI judgment: right tool right place" for the deterministic parts, but Track 03 and Track 02 both explicitly want a model with measured performance, not just a decision tree of if-statements. A calibrated statistical model is the minimum that satisfies "AI" honestly. |

State the LLM/no-LLM boundary as a structural fact, not a policy: the message-generation module's function signature has no parameter through which a Razorpay client could ever be passed in. That's the sentence to put in a code comment directly above the LLM call site.

---

## 6. Architecture

```
Razorpay (test mode)
   │  payment.failed / subscription.halted webhook
   ▼
Next.js API route ────────────────────────────────────────────────┐
   │ 1. Read raw body, verify X-Razorpay-Signature (HMAC)          │
   │    + reject events older than a tolerance window (replay)     │
   │ 2. Idempotency check against Upstash Redis (atomic SETNX)     │
   │ 3. Load customer + payment history from Supabase              │
   │ 4. Risk gate (deterministic rules, §11)                       │
   │ 5. Recovery scorer → calibrated P(recover) (in-process, §10)  │
   │ 6. Global shock check (§15, Upstash rolling counter)          │
   │ 7. Compute EV for every action → pick argmax (§4)              │
   │ 8. If action needs language: call Groq, validate JSON schema   │
   │ 9. Execute action (Razorpay Payment Links API, or log-only)    │
   │ 10. Write full audit row to Supabase, with latency + cost      │
   └─────────────────────────────────────────────────────────────────┘
   ▼                                              ▲
Next.js dashboard — batch metrics,      Vitest unit + integration suite,
audit drill-down, calibration chart      run in GitHub Actions on every push
```

One Next.js application. No separate microservice, no container to deploy, no second runtime to keep alive. The test suite and CI box on the right isn't decoration — §18 makes it real, and it's one of the fastest "build quality" signals a reviewer can check without reading a line of your business logic (a green checkmark next to your latest commit is worth more than it should be, precisely because so few submissions have one).

---

## 7. Why this stack (verified free-tier limits, checked 22 Aug 2026)

| Piece | Service | Verified free tier | Why |
|---|---|---|---|
| App + API + dashboard | **Next.js**, local dev; optionally **Vercel Hobby** | 1M invocations/mo, 4 CPU-hrs/mo, 100GB transfer/mo | One codebase, one deploy target. Hobby is explicitly personal/non-commercial — fine for a hackathon submission. |
| Relational data | **Supabase** (Postgres) | 500MB DB, unlimited API requests, 2 active projects, pauses after 7 days idle | Free Postgres with an instant client. The pause is a non-issue with regular commits; one click to resume. |
| Idempotency locks, rolling counters, rate limiting | **Upstash Redis** | 256MB, 500K commands/mo, 10K/sec | REST-based, serverless-friendly — no persistent connection needed from a Next.js route. |
| LLM (message drafting, rationale) | **Groq API** | Free developer tier; `openai/gpt-oss-20b` at time of writing (~1000 tok/s, $0.075/$0.30 per 1M in/out tokens) | Real speed, real published pricing you can compute `ComputeCost` from honestly. Model IDs shift — confirm at `console.groq.com/docs/models` before hardcoding. |
| Local webhook delivery | **Cloudflare Quick Tunnel** (`cloudflared tunnel --url http://localhost:3000`) | Free, no account | No signup friction, disposable per dev session. |
| CI | **GitHub Actions** | 2,000 free minutes/mo on public repos (public repos are effectively unlimited) | Runs your test suite on every push — the green checkmark reviewers notice. |
| Offline model training | Local Python + scikit-learn, or Colab | Free | Needed for a few hours, once. Never hosted. |

**Explicitly rejected, with reasons:** AWS (Lambda/Bedrock/API Gateway) — not needed at this scale and adds account/card friction with no rubric benefit. Hugging Face Spaces for a Python microservice — verified during research that creating a new Docker/Gradio Space on a personal account now requires a paid PRO plan; the only free path (ZeroGPU Gradio, capped at 2 Spaces) doesn't fit a plain CPU inference API. A separate Python service in general — even where hosting exists for free, a network hop to a second service that can cold-start is a reliability risk specifically in a recorded, one-shot demo; removing the network boundary removes a whole class of "it worked yesterday" failures.

---

## 8. Data model (Supabase / Postgres)

```sql
create table customers (
  id text primary key,
  name text,
  phone text,
  email text,
  ltv_amount numeric default 0,
  successful_payments int default 0,
  failed_payments int default 0,
  risk_score numeric default 0,
  created_at timestamptz default now()
);

create table transactions (
  id text primary key,               -- Razorpay payment id
  customer_id text references customers(id),
  amount numeric not null,
  currency text default 'INR',
  scenario text not null default 'subscription',  -- 'subscription' | 'b2b_receivable' (§16)
  status text not null,              -- 'failed' | 'recovered' | 'abandoned' | 'escalated'
  error_code text,
  error_description text,
  event_id text unique,              -- razorpay event id: idempotency + audit key
  event_created_at timestamptz,      -- from the webhook payload, used for replay-window checks
  retry_count int default 0,
  created_at timestamptz default now()
);
create index on transactions (customer_id);
create index on transactions (status);

create table recovery_audit (
  id uuid primary key default gen_random_uuid(),
  transaction_id text references transactions(id),
  p_recover numeric,
  risk_score numeric,
  expected_values jsonb,             -- { "RETRY_NOW": 12.4, "WHATSAPP_NUDGE": 8.1, "DO_NOTHING": 0, ... }
  chosen_action text not null,
  rationale text,
  llm_prompt_tokens int,
  llm_completion_tokens int,
  llm_cost_inr numeric,
  decision_latency_ms int,           -- webhook received → action chosen (§19)
  outcome text,                      -- 'success' | 'failed' | 'pending' | 'skipped'
  created_at timestamptz default now()
);

-- Held-out evaluation results, written once per model version, not per transaction.
-- This table existing at all is a signal you evaluated rather than eyeballed.
create table model_evaluations (
  id uuid primary key default gen_random_uuid(),
  model_name text not null,          -- 'recovery_scorer_v1' | 'risk_gate_v1'
  eval_set_size int,
  brier_score numeric,               -- recovery scorer only
  precision numeric,                 -- risk gate only
  recall numeric,                    -- risk gate only
  false_positive_cost_inr numeric,   -- risk gate only — Track 02's own bar, applied internally
  notes text,
  created_at timestamptz default now()
);
```

Every row in `recovery_audit` should be self-explanatory to a stranger reading raw SQL: which transaction, what the model thought, what it decided, why, how long it took, and what happened. That table *is* your audit trail. `model_evaluations` is the receipt proving §4.1 and §11.1 weren't just described in prose.

---

## 9. Webhook ingestion: signature, replay protection, idempotency

**Verified from Razorpay's docs:** the signature is in the `X-Razorpay-Signature` header, HMAC-SHA256 over the **raw, unparsed request body**, keyed with your webhook secret.

```ts
// app/api/webhooks/razorpay/route.ts
import crypto from "crypto";

const MAX_EVENT_AGE_SECONDS = 5 * 60; // reject stale, replayed-but-validly-signed events

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");

  const validSignature =
    expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!validSignature) return new Response("invalid signature", { status: 400 });

  const payload = JSON.parse(rawBody);
  const eventId = req.headers.get("x-razorpay-event-id") ?? payload.id;

  // Replay protection: a validly-signed but old event (e.g. captured and re-sent) is rejected.
  const eventAgeSeconds = Date.now() / 1000 - payload.created_at;
  if (eventAgeSeconds > MAX_EVENT_AGE_SECONDS) {
    return new Response("event too old, rejected", { status: 400 });
  }

  // Idempotency: atomic SET NX acquired BEFORE any read or write, closing the race
  // where two concurrent deliveries both pass verification before either locks.
  const acquired = await redis.set(`lock:${eventId}`, "1", { nx: true, ex: 60 * 60 * 24 });
  if (!acquired) return new Response("duplicate, ignored", { status: 200 });

  // ... hand off to the decision pipeline (§10-§15) ...
}
```

**Two ways to generate real events, use both:**

1. **Real, single, live events (proves the plumbing is real):** in Razorpay's test dashboard, create a test payment and click **Failure** on the mock bank page (test mode ships one with explicit Success/Failure buttons). Point your webhook URL at your Cloudflare quick tunnel. This gets you one genuine, signed `payment.failed` delivery.
2. **Synthetic, signed, batch replay (for the batch metrics Track 03 asks for):** a script generates ~200–300 synthetic failed-payment records per scenario (§17), signs each with your real webhook secret via the same HMAC function, and POSTs them to your own endpoint. Deterministic and reliable for a recorded demo, which a live tunnel is not.

---

## 10. The recovery scorer — training, inference, calibration

**Training (once, offline):**

```python
# train_scorer.py — run locally once; commit the output JSON, not this script's venv.
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import brier_score_loss
import json

FEATURES = [
    "prior_success_rate", "days_since_last_failure", "amount_zscore",
    "retry_count_so_far", "is_recurring_subscription", "hour_of_day_risk",
]

X_train, X_holdout, y_train, y_holdout = train_test_split(X, y, test_size=0.25, random_state=42)

model = LogisticRegression()
model.fit(X_train, y_train)

# Calibration check (§4.1) — compute and log this, don't just fit and ship.
holdout_probs = model.predict_proba(X_holdout)[:, 1]
brier = brier_score_loss(y_holdout, holdout_probs)
print(f"Held-out Brier score: {brier:.4f}")  # write this into model_evaluations

json.dump({
    "intercept": model.intercept_[0],
    "coefficients": dict(zip(FEATURES, model.coef_[0].tolist())),
    "trained_on": len(X_train),
    "holdout_brier_score": brier,
}, open("recovery_model.json", "w"), indent=2)
```

**Inference (in-process, no hosting):**

```ts
import model from "./recovery_model.json";

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }

function scoreRecovery(features: Record<string, number>): number {
  const z = Object.entries(model.coefficients)
    .reduce((sum, [k, w]) => sum + w * (features[k] ?? 0), model.intercept);
  return sigmoid(z);
}
```

Print the calibration plot (§4.1) to a static PNG committed under `docs/calibration.png`, and reference it from the README. A chart that isn't in the repo didn't happen.

**A real side-by-side, if you build one:** train the same features into an XGBoost model, export via `onnxmltools` to ONNX, run with `onnxruntime-node` in the same process (no new hosting — the earlier version of this document wrongly assumed a separate hosted service was required; it isn't, for a model this small). Report both models' held-out Brier scores and inference latency in `docs/DECISIONS.md` (§25) side by side. This turns "we chose logistic regression" from an assertion into a measured tradeoff, which is a materially stronger AI-judgment signal.

---

## 11. The risk gate

A small, deterministic, weighted rule set — not ML, not an LLM — that flags a transaction independent of the recovery-value optimization: velocity of failures from the same card/UPI handle in a short window, billing/shipping geography mismatch, amount far outside this customer's historical range, and the systemic-shock flag from §15. If `riskScore(s)` crosses a threshold, `RiskPenalty` in §4 is set high enough that no action outranks `ESCALATE_HUMAN`. The EV calculation still runs in full for the audit trail even when the risk gate wins — you always want the counterfactual on record.

### 11.1 Evaluate it like Track 02 asks, even though you're not submitting there

Hold out a labeled synthetic set (some transactions deliberately constructed as true positives — genuinely risky — and true negatives). Report:

- **Precision** — of everything flagged, what fraction was actually risky.
- **Recall** — of everything actually risky, what fraction got flagged.
- **False-positive cost** — for every false positive, a real customer got escalated/delayed unnecessarily; multiply the false-positive count by your estimated friction cost (§4's `InterventionCost` table) and report the total. This is Track 02's bar, verbatim, applied as an internal discipline. Write one sentence in the README explaining *why* you did this even though you submitted under Track 03 — it's a deliberate signal, make sure it reads as one.

Write these three numbers into `model_evaluations`, not just a slide.

---

## 12. The LLM layer — Groq

**Model:** default to `openai/gpt-oss-20b`; confirm the current ID and pricing at `console.groq.com/docs/models` before you build, and note whatever you actually used in the README, since your `ComputeCost` numbers derive from it.

**Used for exactly two things:** drafting the recovery nudge (email/SMS/WhatsApp copy, including an optional Hinglish variant per Track 03's own suggested direction), and producing a one- or two-sentence human-readable rationale for `recovery_audit.rationale` from the already-computed decision. The LLM explains a decision made deterministically; it never makes the decision.

**Guardrails enforced in code:**
- Force structured output (JSON mode) against a fixed schema: `{ message: string, tone: "neutral"|"empathetic"|"urgent", confidence: number }`. Reject and fall back to a template on validation failure — log the failure rate; a 0% fallback rate across a real batch is itself worth reporting.
- The function that calls Groq has no parameter through which a Razorpay client instance could be passed. Not a policy — a type signature.
- Log `prompt_tokens`, `completion_tokens`, computed `llm_cost_inr`, and call latency on every invocation (§19). This is `ComputeCost(a)` in §4, made of real, checkable numbers.

---

## 13. Batch metrics and unit economics

Run each scenario's held-out batch (§17) through the full pipeline and report, without smoothing over the unflattering parts:

- Total revenue at risk (sum of failed amounts)
- Revenue recovered (sum where `outcome = 'success'`)
- Recovery rate (%), **and the naive-baseline comparison**: what a retry-everything-immediately system would have recovered and at what cost, computed on the same batch
- Count and value of `DO_NOTHING` decisions, broken down by reason (`expected value negative` vs `risk gate override`)
- Count escalated, and why
- Total `llm_cost_inr` spent across the batch, versus revenue recovered — this ratio is your best single unit-economics number
- p50/p95 decision latency (§19)

The naive-baseline comparison is new relative to the earlier draft of this spec, and it matters: "we recovered 36%" means nothing without a reference point. "We recovered the same revenue as retry-everything, at a third of the intervention cost, because we didn't chase 40% of the batch that had negative expected value" is a claim a reviewer can actually evaluate.

---

## 14. Escalation and stopping rules, with invariants

- **Escalation:** the risk gate firing, or `retry_count_so_far ≥ 3` with no success, routes to `ESCALATE_HUMAN` and excludes the transaction from further automation. Log the specific trigger.
- **Stopping rule:** at most 3 automated attempts per transaction, minimum-spaced (immediate, +2h, +24h), tracked via `retry_count_so_far`. After that: `ESCALATE_HUMAN` or `DO_NOTHING`, never a fourth silent retry.

**Write these as property-based invariant tests, not just manual checks** (§18 has the harness):
- For any batch, `sum(recovered_amount) ≤ sum(amount_at_risk)`.
- No `transaction_id` ever has two `recovery_audit` rows for the same `event_id` (idempotency, proven, not just asserted).
- No transaction's `retry_count` exceeds 3.
- For any transaction where `chosen_action != 'DO_NOTHING' and chosen_action != 'ESCALATE_HUMAN'`, the logged `expected_values[chosen_action] > 0` (the system never knowingly acts on negative EV, except via an explicit, logged risk-gate override).

A reviewer who sees invariant tests, not just feature tests, is seeing exactly "would I trust this" answered in code instead of asserted in prose.

---

## 15. The systemic-shock detector

Correlated failures need a different response than independent ones — retrying 40 payments against one bank's degraded authentication service is 40 wasted attempts, not 40 independent decisions. A rolling counter in Redis, no queue or cron needed:

```ts
const key = `failrate:${bank}:${errorCode}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 300); // 5-minute rolling window

if (count > SHOCK_THRESHOLD) {
  await redis.set(`suppress:${bank}:${errorCode}`, "1", { ex: 900 });
}
```

Check the `suppress:*` flag before recommending `RETRY_NOW`; if set, route to `RETRY_LATER` and note the systemic (not individual) cause in the rationale. In the demo, fire 30–40 synthetic failures sharing a bank/error code in quick succession and show the system's behavior changing mid-batch — this is the moment that separates "per-row classifier" from "system that models its own environment," and it's cheap enough to build that there's no good reason to leave it as a stretch goal now that timeline isn't the constraint.

---

## 16. A second scenario: the B2B receivables chaser (proving generalization)

Everything above is written around one story — a subscription merchant's failed payments. Building a second scenario on the *same* decision engine (§4's EV formula, the same scorer architecture retrained on different features, the same risk gate, the same audit trail) is the single strongest way to prove the architecture isn't secretly a one-off script wearing an equation as a costume — which is exactly the kind of thing a skeptical reviewer assumes by default.

**The scenario:** a fictional B2B merchant with overdue invoices instead of failed card payments. States are `pending`, `overdue_15d`, `overdue_30d`, `overdue_60d+`. Actions become `{SEND_REMINDER, OFFER_PAYMENT_PLAN, ESCALATE_COLLECTIONS, WRITE_OFF}` in place of the subscription actions — `WRITE_OFF` plays the same structural role as `DO_NOTHING`: an explicit, logged decision not to keep spending effort. `RecoverableAmount` is the invoice balance; `P(recover)` is a second logistic regression trained on synthetic features specific to receivables (days overdue, customer payment history, invoice size relative to that customer's average). Reuse the EV function, the risk gate, the audit schema (the `scenario` column in `transactions` from §8 already anticipates this), and the dashboard — only the feature set, action list, and cost table change.

This is genuinely a half-day to a day of work once §4–§14 exist, because you're instantiating an architecture, not building a second one. It is worth doing before any of the stretch items in §25.

---

## 17. Synthetic data generation

One script, `generate_synthetic_data.ts` (or Python), producing, per scenario:

- 30–50 fictional customers/merchants with a plausible history (`successful_payments`, `failed_payments` or `on_time_payments`/`late_payments`).
- 200–300 failed transactions or overdue invoices, with realistic error codes / aging buckets, amounts, and timestamps.
- Deliberately include: a cluster of 30+ failures sharing one bank/error code within a short window (feeds §15), a handful of high-amount + high-risk cases (feeds the risk gate and `ESCALATE_HUMAN`), and a non-trivial bucket of low-amount + low-recoverability cases (feeds `DO_NOTHING`/`WRITE_OFF` — it needs to be non-empty and defensible).
- A proper **train / calibration-holdout / demo-batch** three-way split, so the number you report in the demo isn't measured on data the model was fit or calibrated against.

Commit the generator. A reviewer being able to regenerate your exact demo data from source code is itself a build-quality signal.

---

## 18. Testing and CI

**Unit tests (Vitest or Jest)** for every pure function: the EV calculator, the sigmoid/scorer, the risk-gate rule set, the stopping-rule counter, the HMAC verification function (test it against a known Razorpay-documented example payload/signature pair, not just your own generated ones), the JSON-schema validator for LLM output (including the fallback path — deliberately feed it malformed output and assert the template kicks in).

**Property-based / invariant tests** for the four invariants listed in §14, run against the synthetic batch, not hand-picked examples.

**Integration test** for the webhook route: spin up against a test Supabase project (or a local Postgres via `docker compose` if you'd rather not touch your real project) and a test Upstash DB (or `ioredis-mock`), POST a signed payload, assert a `recovery_audit` row exists with the expected shape, POST the identical payload again, assert no second row was written.

**CI**, one file:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test
```

The green checkmark this produces next to your commits is disproportionately persuasive relative to how little effort it takes — most student submissions have none of this, and a reviewer who skims commit history (§2) notices immediately.

---

## 19. Observability

Structured (JSON) logs for every webhook received and every decision made — not `console.log("got webhook")`, but `logger.info({ event: "webhook_received", eventId, paymentId, latencyMs })`. This costs nothing extra to build if you do it from the start and saves real time when something breaks during the demo-recording phase, because you'll have a trail instead of a guess.

Record, per decision: `decision_latency_ms` (webhook received → action chosen, already in the §8 schema), and separately, LLM call latency (since that's the one network-dependent leg). Report **p50 and p95** of both across your demo batch in the README — not an average, which hides the tail. This is a small addition that reads as genuine production instinct: averages lie about what the tail looks like, and a reviewer with backend experience will notice if you report one anyway.

---

## 20. Security, compliance, and defense-only discipline

- **Replay protection** (§9): reject webhooks older than a tolerance window even if validly signed.
- **Rate limiting** the webhook endpoint itself (a simple Upstash-backed token bucket keyed by source) so a burst — real or synthetic — can't overwhelm the Supabase free tier's connection limits.
- **Secrets hygiene:** `.env` in `.gitignore` from the first commit, `.env.example` with blank values, a pre-commit check (even a one-line `grep` in a git hook) that refuses to commit anything matching `rzp_live_` or a Groq key pattern.
- **No real customer data, ever.** Everything is synthetic, generated by your own script, for fictional merchants.
- **Strictly defensive**, per Track 02's bar even though you're not submitting there: the system recommends and executes bounded, reversible recovery actions — a payment link, a nudge, an escalation. It never does anything resembling fraud tooling, chargeback abuse, or anything offense-capable. State this as a one-line constitutional constraint in the README.
- **No real messaging channels with real phone numbers/emails** for the demo — log the message as if sent, or use a sandboxed test channel (e.g. Twilio's WhatsApp sandbox, which only reaches numbers that have explicitly opted in).

---

## 21. Repo hygiene and commit history

Since §2 named this explicitly as something reviewers check: commit as you build, not at the end. A rough, honest cadence — schema and scaffold, then webhook ingestion, then the decision engine, then the LLM layer, then tests, then the second scenario, then polish — with commit messages that say what changed and, ideally, one or two that say what broke and what the fix was, is worth more to your evaluation than almost any single feature. If you've been building without committing often, it is worth going back and making a clean, honest history now rather than one mega-commit — a fabricated-looking backdated history is worse than an honest short one, so don't rewrite timestamps; just commit going forward with real messages.

Also worth having, all cheap: a `LICENSE` file (MIT is a fine default for a hackathon repo), a `.github/workflows/ci.yml` (§18), and a `docs/` folder holding the calibration chart (§10) and the ADR (§25) — a repo with a `docs/` folder that contains actual generated evidence, not stock boilerplate, reads as maintained rather than dumped.

---

## 22. Manufacturing a real failure story (for the "what broke" field)

Don't wait for a bug to happen to you under demo pressure — go find one deliberately, in a controlled setting, and document it honestly. Good candidates, roughly in order of how realistic and specific they'll read:

1. **Fire the same signed webhook twice, concurrently** (not sequentially — use `Promise.all` or two parallel curl requests) before either has acquired the Redis lock. If your idempotency check reads-then-writes instead of using an atomic `SETNX`, you will get two audit rows for one event. Fix it, and now you have a real race-condition story with a real fix.
2. **Kill the Node process mid-batch-replay** (`kill -9` on the process, not a graceful `Ctrl+C`) partway through posting 250 synthetic events, restart it, and re-run the remainder. Confirm no transaction gets double-processed and no partial write leaves `recovery_audit` inconsistent with `transactions`.
3. **Feed the LLM deliberately malformed context** (e.g. a transaction with a null `error_description`) and confirm the JSON-schema validation catches a malformed response and the template fallback fires instead of crashing the whole request.
4. **Exhaust the Groq or Supabase free-tier rate limit on purpose** during a large batch run, and confirm your system degrades (queues, backs off, or falls back) rather than silently dropping decisions.

Whichever one you actually hit and fix, write it up with the specific mechanism, not just the symptom — that specificity is the single thing §2 says separates a real answer from a good-sounding one.

---

## 23. The 5-minute demo script

Structure it around the four judging criteria, in this order, naming the criterion as you hit it:

1. **(0:00–0:45) Problem taste.** One sentence: "Most recovery bots ask 'will this fail.' Reclaim asks 'is recovering this worth it' — because retrying every failed payment costs real money and annoys real customers." Show the EV formula on screen for five seconds; don't over-explain it.
2. **(0:45–2:15) Build quality + AI judgment.** Run a batch live. Show the metrics from §13 landing, including the naive-baseline comparison. Point at one `DO_NOTHING` row and read its rationale. Point at one Hinglish-drafted nudge. State the AI/non-AI split from §5 explicitly on camera, and show the calibration chart from §10 for five seconds — a probability with a receipt behind it is a strong, quiet flex.
3. **(2:15–3:15) The systemic-shock moment.** Fire the burst from §15 and show the system noticing and changing behavior mid-batch, not just per-row.
4. **(3:15–4:30) Failure recovery — your real story from §22.** Show it happening live if you can reproduce it in real time; if not, show the before/after (the bug, the fix, and a test that now guards against a regression). This segment is read first on the form — don't rush it, and let it be a little messy; that's what makes it believable.
5. **(4:30–5:00) Close.** One sentence on the second scenario (§16) generalizing the same engine, one on what you'd build next (the ONNX side-by-side, or a real Twilio sandbox integration), and the repo link on screen.

---

## 24. README structure

1. **The premise** — §3, essentially verbatim.
2. **The decision model** — the EV formula (§4) with one worked numeric example, plus the calibration chart (§4.1/§10) and its Brier score.
3. **What's AI and what isn't** — the table from §5, including the "rejected alternatives" table. This section alone answers a full rubric criterion.
4. **Architecture diagram** — §6.
5. **Results** — the batch metrics from §13, with the naive baseline, and the risk-gate precision/recall/false-positive-cost from §11.1.
6. **The second scenario** — a short note on §16, proving the engine generalizes.
7. **What broke** — the honest §22 story.
8. **Setup instructions** that actually work end to end: env vars (§27), `npm install`, `npm run dev`, `npm test`, how to run the batch replay, how to point a tunnel at it.
9. **Explicit boundaries** — the LLM-cannot-call-Razorpay guarantee from §5, as a standalone callout.
10. **Link to `docs/DECISIONS.md`** (§25) for anyone who wants the longer tradeoff story.

---

## 25. Architecture Decision Records (worth the hour)

A short `docs/DECISIONS.md`, three or four entries, each in this shape: *Decision — Context — Alternatives considered — Why this one.* Candidates: logistic regression vs. XGBoost (with your actual side-by-side numbers from §10 if you built it), a single Next.js app vs. a separate scoring microservice (§7's rejected-alternatives reasoning), Supabase vs. a self-hosted Postgres, Groq vs. a larger hosted model for the language layer. This is a small, cheap artifact that reads as unusually mature for a student submission, precisely because it shows you can articulate a tradeoff you *didn't* take, which is the exact phrasing the rubric uses for "AI judgment."

---

## 26. Prepping the 12 form answers

- **Track:** AI Revenue Recovery (Track 03).
- **Project name:** Reclaim (or your chosen alternative).
- **What it solves** — draft: *"Automated payment-failure recovery treats every failure identically and retries everything, which wastes money on unrecoverable payments and annoys customers on recoverable ones. Reclaim scores each failed payment's recoverability and risk, computes the expected value of every possible action including doing nothing, and only acts when the math says it's worth it — with a calibrated probability model, a held-out evaluation, a full audit trail, and hard stopping rules so it never retries indefinitely. The same decision engine also runs a second scenario, B2B receivables, to show it isn't hardcoded to one story."*
- **GitHub repo URL** — public, README complete, CI green, no secrets committed.
- **5-min pitch video** — unlisted YouTube or Loom link.
- **What broke, and how you got out** — your real §22 story, written with the specific mechanism, not the symptom.

---

## 27. Environment variables

```
# Razorpay (test mode)
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxxx

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://xxxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxx

# Groq
GROQ_API_KEY=gsk_xxxxx
GROQ_MODEL=openai/gpt-oss-20b   # confirm current model id at console.groq.com/docs/models
```

Commit `.env.example` with these keys blank. Never commit the real `.env` — see §20 for a pre-commit guard.

---

## 28. Hard constraints (restated, because they matter more than any feature)

- The LLM never calls a Razorpay endpoint, directly or indirectly, and this is enforced by the LLM-calling function's type signature, not by a comment asking it nicely.
- No real customer/transaction data, ever — synthetic only, from your own generator.
- No unsolicited real messages to real phone numbers or emails.
- Nothing offense-capable, per Track 02's bar, held as a constitutional constraint even though you're submitting under Track 03.
- Every action that could execute twice for the same event is guarded by the idempotency lock, proven by a test, not just implemented.

