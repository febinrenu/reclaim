# Setup for real credentials

Nothing below is required to run Reclaim — see the README's "Run it" section. Each of
these upgrades exactly one port from its local adapter to a real service; every
combination, including none of them, is a fully supported state. Set the corresponding
variable in `.env` (copy `.env.example`) and restart.

## Groq — the language model

1. Go to `console.groq.com` and sign in. No card required.
2. **API Keys** → create a key, copy it once (shown a single time).
3. Set `GROQ_API_KEY=gsk_...` and `GROQ_MODEL=openai/gpt-oss-20b`.

Free tier: 30 requests/minute, 8,000 tokens/minute, 1,000 requests/day, 200,000
tokens/day, per organisation. `src/language/budget-guard.ts`'s own limits sit
deliberately below all four so the app degrades to templates before ever actually
hitting Groq's own ceiling.

## Real Postgres — the database

Two options, both give the identical driver (`node-pg`) and dialect:

**Docker, locally** (what this project actually developed and tested against):
```bash
docker compose up -d
# DATABASE_URL=postgresql://reclaim:reclaim_dev_only@localhost:5432/reclaim
```

**Any hosted Postgres** — Supabase, Neon, Railway, RDS, or similar — set `DATABASE_URL`
to that provider's connection string. If the provider gives both a direct and a pooled
connection string, prefer the pooled one: it allows a much higher connection count on
most free tiers. No schema push step is needed beyond setting the variable — migrations
apply automatically on boot (`src/server/boot.ts`), idempotently, tracked in
`schema_migrations`.

**Honestly**: for most of this build, only the Docker path was actually exercised —
every "real Postgres" claim in this repository's docs, tests, and CI was backed by
that path, never by an actual hosted Supabase project (see `docs/adr/0004`). That
changed on D13/D14: a real Supabase project (free tier, direct connection, port 5432)
was wired up and booted against for real — migrations applied cleanly
(`0001_core.sql` through `0007_card_id.sql`), and a real Razorpay webhook delivery
was decided and landed a `recovery_audit` row through it (see the Razorpay section
below). The Docker path remains what CI and the day-to-day dev loop use; Supabase was
verified once, by hand, as a real deployment target.

## Upstash Redis — locks and counters

1. Go to `upstash.com`, sign in, create a Redis database (regional, not global, on the
   free tier).
2. The database page's **REST API** panel gives `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`. Copy both.

**Honestly**: for most of this build, `src/adapters/kv/upstash.ts` threw a clear error
rather than silently falling back — it was unimplemented because no Upstash credentials
had been obtained. On D14, real credentials arrived and the adapter was implemented for
real, over Upstash's REST API (`SET`/`GET`/`DEL`, and `INCR` + conditional `EXPIRE` via
a Lua `EVAL` so the TTL-on-creation-only contract src/ports/kv.ts requires stays atomic
in one round trip). It was verified against a live Upstash database:
`setIfAbsent`/`get`/`incrWithTtl` all round-tripped correctly. The Postgres-backed KV
adapter remains the zero-credential default and is still what CI and Docker-based dev
exercise — Upstash is an optional upgrade, not a requirement, and this project never
needed it specifically to demonstrate anything the Postgres adapter could not.

## Razorpay test mode — payments

1. Sign up at `dashboard.razorpay.com`. Test mode needs no KYC; live mode does, and this
   project never uses live mode — `src/config/env.ts` refuses to boot if
   `RAZORPAY_KEY_ID` starts with `rzp_live_`.
2. Switch the dashboard to **Test Mode**.
3. **Account & Settings → API Keys → Generate Test Key** → set `RAZORPAY_KEY_ID` and
   `RAZORPAY_KEY_SECRET`.
4. **Account & Settings → Webhooks → Add New Webhook**:
   - URL: a public tunnel URL (see below) plus `/api/webhooks/razorpay`
   - Secret: invent a strong random string — this is `RAZORPAY_WEBHOOK_SECRET`, and it
     is a **different value** from the API key secret above. Mixing the two up makes
     every delivery return 400 with no other symptom — the single most likely real
     incident this setup step produces.
   - Events: `payment.failed`, `payment.captured` at minimum.
5. To force a failed test payment: click **Failure** on the mock bank page, or pay by
   UPI to `failure@razorpay`. Do not rely on a specific "failure card number" — none is
   documented.
6. Test mode caps Payment Links at 30 per business. `resolveExecutionMode`
   (`src/ports/executor.ts`) makes every batch-replay event structurally `dry_run`
   regardless of credentials specifically so a 300-event demo batch can never come
   close to that cap — real link creation is reserved for individually-triggered live
   events.

**Honestly**: for most of this build, no real Razorpay-originated webhook delivery had
ever reached a running instance — every delivery in every test, every demo, and every
day's own verification was the payments simulator
(`src/adapters/payments/simulator.ts`) signing its own event through the identical HMAC
path a real delivery would use. That changed on D14: real test-mode credentials were
configured, `src/adapters/payments/razorpay.ts` was implemented for real (Payment
Links over Razorpay's REST API, `reference_id` set to the transaction id so
`findByReference` can look a link back up post-crash without risking the 30-link test
cap), a Cloudflare Quick Tunnel exposed `localhost:3000`, a real test-mode Payment Link
was created live, and a UPI payment to `failure@razorpay` produced one genuine,
Razorpay-signed `payment.failed` delivery. It verified, decided (`RETRY_LATER`, ~1%
predicted recovery), and landed a real `recovery_audit` row in `dry_run` mode.

Later the same day, a second, separate proof closed the loop the other way: a real
₹100 test-mode payment link, paid to completion with a real card, produced two more
genuine Razorpay-signed deliveries — `payment.authorized` then `payment.captured` —
against transaction `pay_TUT6SjUbB46C9u`. Both verified, both were decided by the real
engine, and the second one correctly flipped `transactions.status` to `'recovered'`
from a genuine Razorpay signal, not a synthetic outcome draw. A real finding along the
way, not swept under the rug: `decide()` still computed a fresh decision
(`RETRY_LATER`) on the capture event itself, since nothing short-circuits it just
because a payment succeeded — pre-existing behavior, and exactly the case
`process-event.ts`'s `isFollowup` guard exists to make safe when that decision's own
scheduled follow-up eventually fires against an already-recovered transaction.

`EXECUTOR_MODE` was never flipped to `live` for any of this, so no real money or live
Payment Link was ever at stake beyond the ₹100 the payer actually chose to send through
Razorpay's own test-mode checkout. A handful of genuine deliveries is proof the
verification, ingestion, and status-transition paths all work against Razorpay's real
signatures, not a substitute for exercising it at volume.

## The tunnel, for a real Razorpay delivery to reach localhost

```bash
winget install --id Cloudflare.cloudflared   # or the equivalent for your OS
cloudflared tunnel --url http://localhost:3000
```

No Cloudflare account needed. The printed `https://<random>.trycloudflare.com` URL is
what goes in the Razorpay webhook config above. It changes on every restart.

**The tunnel must never be on the dashboard's streaming path** — Cloudflare Quick
Tunnel does not support Server-Sent Events. `/dashboard` and `/simulate` are recorded
against `localhost`; the tunnel exists only to let a real Razorpay delivery reach the
app at all.
