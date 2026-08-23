# ADR 0001 — Raw parameterised SQL, not Drizzle

**Status:** Accepted. **Date:** 2026-08-24 (D2).

## Context

BUILD_PLAN.md §4 says: "One Drizzle schema, two drivers." §5.1 commitment A2 argues
the same point: PGlite is real Postgres compiled to WebAssembly, so the same SQL text
should run unchanged against PGlite, Docker Postgres, and Supabase, giving one
repository layer instead of three.

D1 already committed `src/ports/sql.ts` with a different design: a thin
`SqlExecutor.query(sql, params)` interface, whose own docstring calls itself
"deliberately a thin SQL executor rather than a query builder or an ORM surface." No
ADR recorded why, and by the time D2 started, the plan text and the checked-in port
disagreed with each other.

## Decision

Keep the raw-SQL port. Migrations are hand-written `.sql` files
(`db/migrations/000N_*.sql`), applied by a small runner
(`src/db/migrate.ts`) that tracks `schema_migrations` and takes an advisory lock on
node-pg. Repositories (`src/repositories/*.repo.ts`) write parameterised SQL directly
against `SqlExecutor`, typed by hand on the way out.

## Rationale

BUILD_PLAN.md's actual argument — "the same SQL text runs against all three targets,
so there is exactly one repository layer" — does not require Drizzle. It requires that
the SQL dialect be uniform across drivers, which plain PostgreSQL SQL already is. A
query builder would add a translation layer between the code and the SQL actually
executed without removing the one thing D1's port exists to avoid: a second code path
per driver. `SqlExecutor.transaction()` already gives repositories a single call shape
that works standalone or nested in a caller's transaction, which is the property the
five-write T4 settle step (BUILD_PLAN.md §5.6) actually depends on — Drizzle's own
transaction API would have to be wrapped to get the same shape back.

Concretely, Drizzle would also add: a new dependency and its own migration tool
(`drizzle-kit`) alongside the hand-rolled advisory-lock runner BUILD_PLAN.md separately
calls for; a schema-definition DSL to keep in sync with the hand-readable `.sql` files
this project wants reviewable as SQL (SYSTEM_SPEC.md §8 asks for exactly that); and a
dialect-mapping layer between Drizzle's PGlite driver and its node-postgres driver that
would have to be trusted rather than tested, since this project cannot exercise it
against Supabase before credentials arrive (§10.2).

## Consequence

BUILD_PLAN.md §4, §5.1 A2, and §10.2's "same Drizzle schema" line are now inaccurate
about the mechanism, though not about the underlying property (one SQL dialect, two
drivers) they were arguing for. Left as-is rather than edited, so the plan's own history
stays legible — this ADR is the correction of record from D2 forward.

`npm run db:push` (§10.2) does not exist under this design. Applying the schema to a
Supabase pooler URI is `runMigrations(sql)` against a `Transactional` built from
`DATABASE_URL`, i.e. just booting the app once with that URL set.
