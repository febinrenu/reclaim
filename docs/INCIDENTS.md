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
