# Task 5 re-review — fix round 1 (`127207b..a007525`)

Scope: `apps/api/src/routes/media.ts` (26 insertions / 6 deletions) and
`apps/api/src/routes/media.test.ts` (122 lines of test changes) only. Ran
`bun test src/routes/media.test.ts` exclusively; the full api suite was not run.

Baseline: `bun test src/routes/media.test.ts` → **19 pass, 0 fail, 36 expect() calls.**

## Verdicts

### C1 (Critical) — thumb route unprotected — **ADDRESSED**

Verified by mutation, both routes independently, each restored with `git checkout --` afterward:

- **Full route** — replaced its `c.body(...)` with `c.redirect(...302...)`. Result: **15 pass, 4
  fail**, including the named `PROXIES on the full route: never a redirect, never a bucket
  hostname, and the body is really the image` (`Expected: 200, Received: 302`), plus the
  content-type, size-comparison, and cache-control tests.
- **Thumb route** — same mutation on the thumb handler. Result: **16 pass, 3 fail**, including
  the named `PROXIES on the thumb route: ...` (`Expected: 200, Received: 302`), plus its own
  content-type and cache-control tests. As the review predicted, the size-comparison test
  (`thumb < full`) did **not** catch this mutation — a redirect's empty body is still smaller —
  confirming the PROXIES test is doing real, independent work on this route now.

**WebP magic-number strengthening — confirmed by construction, not by reading.** I mutated the
full-route handler to `c.json({ url: "https://internal.example/..." }, 200, { "Cache-Control":
CACHE_CONTROL })` — a JSON body, no `Location` header, no bucket-hostname substring anywhere in
the headers, status 200 (not 302). Result: `res.status === 200` passed, `location === null`
passed, the header-hostname grep passed — i.e., **every check the pre-fix test had would have
let this through** — and the suite failed specifically at
`expect(isWebp(bytes)).toBe(true)` inside `expectProxiesRealBytes`
(`Expected: true, Received: false`), in the named `PROXIES on the full route...` test. This is
exactly the gap the review described, and the new assertion closes it.

### I1 (Important) — `CACHE_CONTROL` comment — **ADDRESSED**

The rewritten comment states the condition plainly: "SAFE ONLY BECAUSE EVERY POST IS PUBLIC
TODAY (Phase 3) — this is not a property of the id, it is a property of the current phase, and
Phase 6 breaks it." It then names both mechanisms the original review raised — `public`
authorizing a downstream cache to replay a 200 to a different caller without re-entering the
handler, and `max-age=31536000, immutable` outliving a revoked entitlement in the member's own
browser — and states what Phase 6 must do: "it MUST also stop sending this header on the gated
path — `private, no-store` (or omitting caching entirely) for any response the entitlement check
gated, keeping `public, immutable` only for media that stays ungated." This names the qualifier
the original comment dropped and gives Phase 6 an actionable constraint, not just a mention.

### I2 (Important) — thumb route's missing-bytes guard — **ADDRESSED**

Mutation: deleted `if (object === null) throw new NotFoundError(NOT_FOUND_MESSAGE);` from the
thumb handler only. Result: **18 pass, 1 fail** — exactly the named
`404s a row whose thumb bytes are missing, rather than 500ing`
(`Expected: 404, Received: 500`, with `unhandled error: TypeError: null is not an object`).
Restored cleanly.

`/thumb` now carries content-type (`streams the thumbnail as bytes, with an image content type`),
cache-control (`sets long-lived, immutable caching on the thumbnail bytes it returns`), and
unknown-id 404 (`404s an unknown id on the thumb route`) coverage in addition to the
missing-bytes guard and the size/PROXIES tests — parity with the full route confirmed by reading
the diff and the file at HEAD.

### I3 (Important) — row lookup unpinned in both handlers — **ADDRESSED**

Mutation, each handler in turn, restored between:

- **Full route** — deleted `const row = await deps.mediaRepository.findById(id); if (row ===
  null) throw ...`. Result: **18 pass, 1 fail** — exactly the named
  `404s when the row has been deleted from the database but its bytes remain in storage (full
  route)` (`Expected: 404, Received: 200`).
- **Thumb route** — same deletion on the thumb handler. Result: **18 pass, 1 fail** — exactly the
  named `... (thumb route)` variant (`Expected: 404, Received: 200`).

Each mutation reddens only its own named test, confirming the row-deleted-bytes-orphaned
scenario is now pinned independently per route.

### M1 (Minor) — English 404 message — **ADDRESSED**

`NOT_FOUND_MESSAGE = "media not found"` at HEAD, with a comment explaining the split from
`NO_FILE_MESSAGE`'s Bahasa copy (`NotFoundError` is English at every other call site;
`ValidationError`/`ConflictError` carry Bahasa copy a human reads). Confirmed present in the
current file, not just the diff.

### M2 (Minor) — corrected test counts — **ADDRESSED**

Report claims 19 pass / 36 expect() calls after this round, 12 tests / 8 new before. Actual run
against HEAD: **19 pass, 0 fail, 36 expect() calls.** Matches exactly.

## The premature `git checkout --` disclosure — verified, redone work is complete

The implementer reports wiping its own uncommitted M1/I1 fixes with a premature `git checkout
--` during mutation testing, catching it via `git status`, and redoing the edits before
committing. I confirmed both pieces of redone work are fully present at HEAD (`a007525`):

- M1: `NOT_FOUND_MESSAGE = "media not found"` — present, with its explanatory comment.
- I1: the full rewritten `CACHE_CONTROL` docstring, including the "SAFE ONLY BECAUSE..." framing
  and the explicit Phase 6 instruction — present, word-for-word matching what the report quotes.

No partial restoration. Nothing looks like a half-redone edit or a stale fragment of the
original (now-false) comment.

## Also checked

- **No new breakage.** `bun test src/routes/media.test.ts` is 19/0 clean at HEAD, before and
  after every mutation-and-restore cycle performed during this re-review.
- **Production diff scope.** `git diff 127207b a007525 -- src/routes/media.ts` is 26
  insertions / 6 deletions, confined entirely to the `NOT_FOUND_MESSAGE` value+comment and the
  `CACHE_CONTROL` comment. No route-handler logic changed — consistent with the report's own
  claim that C1/I2/I3 were test-coverage gaps, not implementation bugs. No unrelated
  refactoring found.
- **Tests assert literals, never constants.** `media.test.ts` imports only `describe`, `expect`,
  `it`, `beforeEach`, `createApp`, `bootstrap`, `resetDatabase` — nothing from `routes/media.ts`.
  `"image/webp"` and `"public, max-age=31536000, immutable"` are spelled out as literal strings
  in the assertions, not compared against imported constants.

## Hygiene

All mutations (C1 full, C1 thumb, C1 JSON-body construction, I2 thumb, I3 full, I3 thumb — six
mutation cycles total) were applied and reverted with `git checkout -- src/routes/media.ts`,
each followed by a green 19/0 run before the next.

Final state: `git status --porcelain` empty at repo root and inside `apps/api`; `git diff
--stat` empty.

## Summary

| # | Verdict | Reddening test |
|---|---|---|
| C1 | ADDRESSED | `PROXIES on the full route...` / `PROXIES on the thumb route...`; magic-number check independently confirmed to reject a JSON body |
| I1 | ADDRESSED | judgment call — comment now states the condition and the required Phase 6 change |
| I2 | ADDRESSED | `404s a row whose thumb bytes are missing, rather than 500ing` |
| I3 | ADDRESSED | `404s when the row has been deleted... (full route)` / `(thumb route)` |
| M1 | ADDRESSED | `NOT_FOUND_MESSAGE` is English at HEAD |
| M2 | ADDRESSED | 19 pass / 36 expect() confirmed by direct run |
