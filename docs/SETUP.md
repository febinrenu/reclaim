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

**Honestly**: only the Docker path was actually exercised during this build — every
"real Postgres" claim in this repository's docs, tests, and CI is backed by that path,
never by an actual hosted Supabase project (see `docs/adr/0004`). A hosted provider
should work unchanged, since it speaks the identical SQL dialect, but that specific claim
was not verified against one.

## Upstash Redis — locks and counters

1. Go to `upstash.com`, sign in, create a Redis database (regional, not global, on the
   free tier).
2. The database page's **REST API** panel gives `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`. Copy both.

**Honestly**: `src/adapters/kv/upstash.ts` throws a clear error rather than silently
falling back — it was never implemented (no Upstash credentials were obtained during
this build). Setting these two variables today will fail loudly at boot with a message
saying exactly that, rather than pretending to work. The Postgres-backed KV adapter
(the zero-credential default) is durable and shared across processes already, and this
project never needed Upstash specifically to demonstrate anything the Postgres adapter
could not.

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

**Honestly**: this project has never posted a real, Razorpay-originated webhook
delivery to a running instance. Every delivery in every test, every demo, and every
day's own verification was the payments simulator (`src/adapters/payments/simulator.ts`)
signing its own event through the identical HMAC path a real delivery would use — a
real, correct test of the *verification* logic, but not the same as a signature Razorpay
itself produced.

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
