# Reclaim

**Risk-aware revenue recovery. It prices every recovery action, including doing nothing.**

Most systems in this space predict whether a payment will fail. Reclaim asks a different question:
given a payment has already failed, **is it worth spending money and risk to get it back, and if
so, how?**

Every recovery action costs something. An SMS costs paise, a support escalation costs an agent's
time, and chasing a customer who was never going to pay costs goodwill you cannot buy back. Every
rupee spent pursuing an unrecoverable payment is a rupee that should have gone somewhere else. So
recovery is a constrained optimisation problem rather than a retry loop, and this system is
explicitly allowed to decide that the right action is none.

For a failed payment in state `s`, and each available action `a`:

```
EV(a) = P(recover | s, a) x RecoverableAmount
        - InterventionCost(a)
        - ComputeCost(a)
        - RiskPenalty(s, a)
        - ContactFatigueCost(s, a)

choose a* = argmax EV(a)
```

Note that `EV(DO_NOTHING)` is **not** zero. Customers retry on their own, so doing nothing has a
real, positive expected value, and the quantity that actually matters is the uplift of acting over
not acting. Treating it as zero would credit every intervention with recovery that would have
happened anyway.

---

## Run it

```bash
git clone <repo> reclaim
cd reclaim
npm install
npm run dev
```

That is the whole setup. **No API keys, no `.env` file, no Docker, no database to provision.**

This is deliberate, and it is the most important architectural decision in the project. Every
external dependency sits behind a port with two implementations, and the one that runs is chosen by
whether a credential happens to be present:

| Port | With credentials | Without |
|---|---|---|
| Database | Supabase or any Postgres, via `DATABASE_URL` | PGlite, a real Postgres compiled to WebAssembly, running in process |
| Locks and counters | Upstash Redis | Postgres-backed, durable and shared across processes |
| Language | Groq | A deterministic template engine, including a Hinglish variant |
| Payments | Razorpay test mode | A simulator that signs its own webhooks through the identical HMAC path |

Nothing degrades silently. The app prints its own configuration on boot and serves the same table
at `/api/health`, so you can see exactly which parts are backed by a real service before anything
has a chance to mislead you.

```
  Reclaim 0.1.0   mode: LOCAL, zero credentials
  --------------------------------------------------------------------------
   -    database    pglite      .data/pglite     embedded Postgres, no Docker needed
   -    locks       postgres    kv table         never the idempotency authority
   -    language    template    deterministic    hand written variants including Hinglish
   -    payments    simulator   self signed      identical HMAC path
   -    executor    dry_run     records intent   touches no network
```

To point any single port at a real service, see [`docs/SETUP.md`](docs/SETUP.md). Each one is
independent; partial configuration is a fully supported state.

## Verify it

```bash
npm test          # unit and property tests
npm run typecheck
npm run lint
npm run build
```

The test suite needs **no secrets**, because tests pin the local adapters and the container never
reads the environment. That is why CI has no secret configuration at all, which you can confirm by
reading [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Where the model is, and where it deliberately is not

| Layer | Implementation | Responsibility |
|---|---|---|
| State transitions, retry limits, money arithmetic, the EV formula, idempotency, stopping rules, audit logging, every payments API call | Plain TypeScript, unit tested | Anything where being wrong costs money or trust. No model in the loop, ever. |
| `P(recover \| s)` | Logistic regression trained offline, calibration checked | A calibrated probability, not a raw score |
| Recovery message copy, and the sentence explaining a decision already made | Language model, or a deterministic template | Language only. Never touches a number that affects money movement. |

**The language model structurally cannot reach a payments client.** Not by policy, by construction,
and enforced five ways: the only channel into a language call is a recursive plain-JSON type that
no method-bearing object satisfies; a `DataOnly<T>` mapped type turns any function-, Promise-, or
class-valued field into `never`, making such an argument unconstructible; the service's dependency
type has no slot for a payments port; an ESLint boundary rule forbids the import; and a test walks
the transitive import graph so the guarantee survives a refactor that tries to disable the lint rule.

There is also an ordering guarantee that is arguably stronger than all five. The pipeline is
**decide, then speak**. The decision function has already returned before any language call is
made, and the copy result type carries no action field. Even a fully adversarial model response
cannot change what gets executed. It can only change a string in a rationale column.

## Build status

Day one of thirteen. What exists today:

- The zero-credential capability layer, the boot banner, and `/api/health`
- Integer money arithmetic in paise and millipaise, because floats would put
  `12.399999999999998` on screen and would make the policy simulator report phantom deltas
- Seeded pseudo-randomness and injected clocks, so a batch replays identically
- The type-level language firewall
- Four ESLint boundary rules and a runtime purity gate, both of which caught real layering
  mistakes on their first run
- 77 unit tests, green on Linux and Windows

Not built yet: the decision engine, the webhook and worker, the audit ledger, the dashboard, the
policy simulator, and the second scenario. The sequence and reasoning are in
[`BUILD_PLAN.md`](BUILD_PLAN.md); the product brief is in [`SYSTEM_SPEC.md`](SYSTEM_SPEC.md).

## Constraints held throughout

- No real customer data. Everything is synthetic, generated by a committed script from a seed.
- No unsolicited messages to real phone numbers or email addresses.
- Live payment credentials are refused at startup. Test mode only.
- Strictly defensive. The system recommends and executes bounded, reversible recovery actions.
- Every action that could execute twice for one event is guarded by a uniqueness constraint in the
  same transaction as the write, proven by a test rather than asserted in prose.

## Licence

MIT. See [`LICENSE`](LICENSE).
