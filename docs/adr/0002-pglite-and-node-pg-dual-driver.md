# ADR 0002 — PGlite as the zero-credential default, node-pg as the upgrade

**Status:** Accepted. **Date:** 2026-08-24 (D2).

## Context

SYSTEM_SPEC.md's own architecture assumed Supabase as the only database, meaning a
fresh clone with no credentials cannot run at all. BUILD_PLAN.md §4's zero-credential
mandate rejects that: every external dependency must have a real adapter and a local
one, chosen by whether a credential is present, and "absent is never an error."

## Decision

`DB_DRIVER=pglite` (the default, chosen when `DATABASE_URL` is unset) runs PGlite — real
Postgres compiled to WebAssembly, embedded in the Node process, persisted to
`.data/pglite`. Setting `DATABASE_URL` switches to `node-pg` against any real Postgres:
Docker Compose locally, or a Supabase pooler URI. Both drivers implement the identical
`SqlExecutor`/`Transactional` port (ADR 0001), so every repository, every migration,
and the entire integration test suite runs unchanged against either.

## Rationale

The alternative — an in-memory mock or a fixture-based fake — would make the D2 exit
test ("the same repository suite passes twice, once on each driver") vacuous: a mock's
transactional behaviour is this project's own code, so testing against it proves
nothing about real Postgres semantics (`FOR UPDATE SKIP LOCKED`, advisory locks, real
constraint violations). PGlite being *actual* Postgres, not an emulation, is what makes
"deleting `.data/` rebuilds cleanly" and "the crash-recovery test passes on the
embedded driver" real claims rather than claims about a stand-in.

The known cost: PGlite is a single embedded connection, so concurrent load queues
behind it rather than parallelising (documented directly, with measured p50/p95
numbers, in `docs/INCIDENTS.md`'s D6 entry) — a genuine limitation, not hidden, and the
reason `DATABASE_URL` exists as an escape hatch for anything that needs real
concurrency (the CI integration job's node-pg service container, in particular).

## Consequence

Every migration must be plain, cross-driver-compatible SQL — no Supabase-specific
extensions, no `pg_cron`, nothing PGlite's WASM build does not implement. This has held
without exception through 0007 migrations. The CI integration job (added the same day
as this ADR was backfilled, see `docs/INCIDENTS.md`'s 2026-08-26 entry) now runs the
full integration suite against both drivers on every push, closing the gap between
"the property is designed to hold" and "the property is checked."
