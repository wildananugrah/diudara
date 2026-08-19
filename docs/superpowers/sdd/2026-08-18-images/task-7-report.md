# Task 7 report: `MAX_POST_IMAGES` and `GET /users/limits`

Commit: `d7038a9` on `feat/images`, worktree `/home/wildandev/repo/diudara/.worktrees/images`.

## What was built

- `apps/api/src/bootstrap.ts`:
  - `DEFAULT_MAX_POST_IMAGES = 5`.
  - `resolveMaxPostImages(value: string | undefined): number` — trims/treats
    empty as unset, defaults to 5, throws `Error` on anything that is not an
    integer ≥ 1 (non-numeric, `0`, negative, fractional).
  - `Dependencies.maxPostImages: number`, resolved **unconditionally** inside
    `bootstrap()` from `process.env.MAX_POST_IMAGES` (not gated behind any
    feature flag, unlike `resolveAiDailyMessageLimit`'s gate on `aiProvider`)
    so a malformed value fails boot on every box, every time.
- `apps/api/src/routes/posts.ts`:
  - `postBodySchema` became `buildPostBodySchema(maxPostImages)`, built once
    per `postRoutes()` call from `deps.maxPostImages` and used by **both**
    `POST /users/posts` and `PATCH /users/posts/:id` — one schema instance,
    shared.
  - `mediaIds` gained `.max(maxPostImages, "maksimal N foto per kiriman")` —
    Bahasa, names the limit.
  - `postRoutes`'s `Pick<Dependencies, ...>` gained `"maxPostImages"`.
- `apps/api/src/routes/users.ts`:
  - `GET /limits` — public (no `requireAuth`), mounted above the `/:handle`
    routes, returns `{ maxPostImages: deps.maxPostImages }`. No DB read.
  - `userRoutes`'s `Pick<Dependencies, ...>` gained `"maxPostImages"`.
- `apps/api/src/domain/handle.ts`: `"limits"` added to `RESERVED_HANDLES`.
- `apps/api/.env.example`: documented `MAX_POST_IMAGES` (commented out,
  default 5), same style as `AI_DAILY_MESSAGE_LIMIT`.
- Tests: `bootstrap.test.ts` (`resolveMaxPostImages` unit tests +
  `bootstrap() MAX_POST_IMAGES wiring`), `routes/posts.test.ts`
  (`Task 7: MAX_POST_IMAGES`), `routes/users.test.ts` (`GET /users/limits`).
  Also fixed two pre-existing hand-built `Dependencies` object literals in
  `bootstrap.test.ts` (lines ~715, ~932) that needed `maxPostImages: 5`
  added once the field became required — caught by `tsc --noEmit`, not by
  `bun test` (which doesn't type-check).

## Is the cap enforced on BOTH create and edit? Yes.

`postRoutes` builds `postBodySchema` **once**, from `buildPostBodySchema(deps.maxPostImages)`,
and passes that same instance to `validate(postBodySchema)` on both
`app.post("/posts", ...)` and `app.patch<"/posts/:id">("/posts/:id", ...)`
(`apps/api/src/routes/posts.ts`). There is no separate create-only or
edit-only schema, so there is no way for the two verbs to disagree.

Proven by a route test that isolates the count as the only variable: six
**real, owned, unclaimed** media ids (via `uploadFixtures`, not fake uuids)
submitted to `PATCH /users/posts/:id` on an existing post 400s, exactly like
`POST /users/posts` does with six of its own. Using real/owned ids matters —
an earlier version of this test used six syntactically-valid-but-nonexistent
uuids and it passed even *before* the cap existed, because those ids already
400 on ownership grounds (`foto tidak ditemukan atau bukan milik Anda`). That
would have been a false green. The final test only exercises the count.

## Red phase output

`resolveMaxPostImages` was temporarily stubbed to `return -1` so the test
file could load, then the four unit tests were run and failed on their own
assertions (not a load error):

```
expect(resolveMaxPostImages(undefined)).toBe(5)         -> Received: -1
expect(resolveMaxPostImages("")).toBe(5)                -> Received: -1
expect(resolveMaxPostImages("1")).toBe(1)                -> Received: -1
expect(() => resolveMaxPostImages("banyak")).toThrow(...) -> Received function did not throw. Received value: -1
4 fail, 0 pass
```

`bootstrap() MAX_POST_IMAGES wiring` (before `deps.maxPostImages` was wired):

```
expect(deps.maxPostImages).toBe(5)  -> Expected: 5, Received: undefined
expect(deps.maxPostImages).toBe(3)  -> Expected: 3, Received: undefined
"fails closed on an invalid MAX_POST_IMAGES..." -> bootstrap() did not throw
  (returned a full Dependencies object instead) — assertion failed on
  .toThrow(), not a crash.
```

`GET /users/limits` (before the route existed):

```
expect(res.status).toBe(200)  -> Expected: 200, Received: 404
```

`POST`/`PATCH /users/posts` over-limit tests (before `.max()` existed):

```
POST  6 owned images -> Expected: 400, Received: 201
PATCH 6 owned images -> Expected: 400, Received: 200
"the refusal names the limit, in Bahasa" -> Received: "foto tidak ditemukan
  atau bukan milik Anda" (fake ids hit ownership check instead — this is
  the test that caught the false-green risk above)
```

All were genuine reds for their own assertion, never a module-load failure.
After implementation, all turned green (see counts below).

## Reserved-handle guard, with positive control

Baseline (`"limits"` not yet in `RESERVED_HANDLES`, route not yet mounted):

```
bun test src/routes/users.test.ts -t "every literal /users segment"
1 pass, 0 fail   (vacuously — the guard had nothing to catch yet)
```

After adding both `GET /users/limits` and `"limits"` to `RESERVED_HANDLES`
together, ran the **positive control**: removed `"limits"` from
`RESERVED_HANDLES` while the route stayed mounted, and reran the guard:

```
expect(shadowable.size).toBeGreaterThanOrEqual(5)   -> passed
expect(unprotected).toEqual([])
  - []
  + ["limits"]
1 fail
```

The guard correctly detected the unreserved `limits` segment. Restored
`"limits"` to `RESERVED_HANDLES` and reran:

```
1 pass, 0 fail
```

This mirrors Task 4's `media` control exactly: watched the guard fail, then
pass, rather than only ever seeing it pass.

## Malformed `MAX_POST_IMAGES`

- `"banyak"`, `"0"`, `"-2"` (and `"1.5"`) all throw synchronously from
  `resolveMaxPostImages`, with message
  `MAX_POST_IMAGES must be a whole number of at least 1 (got "<value>"). Unset it to use the default of 5.`
- Because `bootstrap()` calls `resolveMaxPostImages` **unconditionally**
  (not gated behind any optional feature), this throw happens at process
  boot and stops the process from starting — it can never reach runtime as
  `NaN` and silently reject every post with an image. Verified via
  `bootstrap() MAX_POST_IMAGES wiring > fails closed on an invalid
  MAX_POST_IMAGES...`, which asserts `expect(() => bootstrap()).toThrow(...)`
  under `withEnv({ MAX_POST_IMAGES: "not-a-number" })`.

## `GET /users/limits` is public

Confirmed by reading the diff: the route is registered as
`app.get<"/limits">("/limits", (c) => {...})` with **no** `requireAuth`
middleware in the chain (contrast with `/me`, which has `requireAuth` as its
second argument). The route test also calls it with no `Authorization`
header and gets 200.

## Test counts

- Covering files (`users.test.ts` + `posts.test.ts` + `bootstrap.test.ts`)
  run together: **311 pass, 0 fail** (up from 300 before this task's 11 new
  tests: 4 `resolveMaxPostImages` unit tests + 3 `bootstrap()` wiring tests
  in `bootstrap.test.ts`, 3 in `posts.test.ts`, 1 in `users.test.ts`).
- Full API suite, run once in the foreground with `timeout: 400000`:
  **2148 pass, 0 fail, 5763 expect() calls, across 145 files, 233.01s** (up
  from 2137 before — the same +11 delta). No regressions elsewhere.
- `bunx tsc --noEmit`: clean, after fixing two pre-existing hand-built
  `Dependencies` literals in `bootstrap.test.ts` that needed the new
  required `maxPostImages` field.

## Things I'm unsure about

- The Zod issue message for `.max()` is prefixed with the field path by
  `describeIssues` (`http/validate.ts`), so the wire error is
  `"mediaIds: maksimal 5 foto per kiriman"` rather than the bare Bahasa
  string. This matches the existing pattern for every other route-level
  validation error in this file (e.g. `q`/`limit` messages), so I left it as
  is rather than special-casing this one field.
- `resolveMaxPostImages` takes a bare `string | undefined` rather than the
  `{ value }` object wrapper `resolveAiDailyMessageLimit` uses — this
  matches the exact call signature given in the task brief's own test
  snippet (`resolveMaxPostImages(undefined)`), so I followed the brief over
  strict consistency with the older resolver's shape. Flagging in case the
  brief's snippet was illustrative rather than a literal signature
  requirement.
