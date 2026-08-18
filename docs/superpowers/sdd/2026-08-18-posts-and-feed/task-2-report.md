# Task 2 report: use cases, shared limits, and the API routes

Status: **DONE** after Fix round 1 (round 1 submission was spec ❌ — see that
section below for the full review disposition)
Commits: `97e4d77` (initial), `53fb863` (fix round 1) on `feat/posts`
(HEAD before this task: `0c69083`)
Worktree: `/Users/bellinnn/Documents/projects/diudara/.worktrees/posts`

## One-line test summary (final, after Fix round 1)

Root gates green: `bun run typecheck` clean across all 4 workspaces;
`bun run test` — shared 82/0, worker 38/0, web 514/0, **api 2036/0** (2670 total,
up from the pre-task 2613 baseline). See "Fix round 1" below for what changed
between the initial 2029 and this 2036, and for the two Critical findings that
made the initial submission incorrect regardless of the green suite.

## What was built

- **Step 0** — `ForbiddenError` added to `apps/api/src/application/errors.ts`
  (403), plus a new `errors.test.ts` pinning `new ForbiddenError().status === 403`.
  No existing 403 class existed before this.
- **Step 1** — `MAX_POST_BODY_LENGTH = 1000` added to
  `packages/shared/src/auth.schema.ts`, following `MAX_EXPLORE_QUERY_LENGTH`'s
  docstring style. `DEFAULT_FEED_PAGE_SIZE`/`MAX_FEED_PAGE_SIZE` stayed local to
  `apps/api/src/routes/posts.ts` per the brief's reasoning (the client never
  reads them — pagination is cursor-driven).
- **Steps 2-3** — `post-views.ts` + test: `toPostView`/`toFeedPage`, exactly as
  specified in the brief. Wire keys pinned via `Object.keys().sort()`.
- **Steps 4-5** — `write-post.ts` + test: `CreatePost`/`EditPost`/`DeletePost`
  against a hand-written `FakePosts` implementing `PostRepositoryPort`, exactly
  as specified.
- **Step 6** — `read-posts.ts` + a new `read-posts.test.ts` (the brief left this
  as a checklist, not code). Covers: `untuk-anda` calls `listGlobal` and never
  `listFollowing`; the literal `21` (`limit + 1`) is asserted when no limit is
  given; `mengikuti` calls `listFollowing` with the viewer id and never
  `listGlobal`; the cursor is passed through untouched; an unknown handle
  throws `NotFoundError` before `listByAuthor` is ever called; handle
  normalisation (leading `@`, case) is exercised through a hand-written
  `FakeUsers`/`FakePosts` pair — no mocking framework.
- **Steps 7-8** — `routes/posts.ts` (verbatim from the brief, using
  `Pick<Dependencies, ...>` to mirror `userRoutes`'s own idiom) and a new
  `routes/posts.test.ts` (also left as a checklist). 26 tests covering every
  line of the brief's list, plus the two-routers-on-one-prefix proof described
  below.
- **Step 9** — wired into `bootstrap.ts` (`DrizzlePostRepository` + the five
  use cases, added to `Dependencies` and to both hand-built `Dependencies`
  literals in `bootstrap.test.ts` via a new `fakePostRepository`) and into
  `app.ts` (`app.route("/users", postRoutes(deps))` alongside the existing
  `userRoutes` line).

## Three things the brief called out, verified

1. **`ForbiddenError` / 403 mapping.** Pinned directly (`errors.test.ts`) and
   indirectly — every route test that expects a 403 asserts
   `res.status === 403`, never `instanceof`.
2. **Two routers on one prefix.** ~~Checked for a literal collision first...
   mount order non-load-bearing here~~ — **THIS WAS WRONG, and is corrected in
   Fix round 1 below.** The claim (both in this report and in a code comment
   in `app.ts`) was that no route in either file shares a literal shape with
   a route in the other, and that mount order therefore does not matter.
   Round 1 review found that false by actually swapping the two lines and
   running the suite: it passed 2029/0 anyway, because the test written to
   "prove" order-independence asserted only `/:handle/posts` and
   `/:handle/followers` — two shapes that never collided in either direction
   — so it could never have caught a real collision. See **Fix round 1, C1/C2**
   for the real collision, the corrected mount order, and a test that
   actually goes red on the swap.
3. **The `/users/feed` auth split.** `tab=untuk-anda` with no `Authorization`
   header → 200; `tab=mengikuti` with no header → 401; `tab=mengikuti` with a
   session → 200. All three pinned directly, plus a follow-through test
   (`mengikuti excludes the viewer's own posts, includes only followed
   authors`) exercising the real `listFollowing` join.

## Import paths checked against the real files (not trusted from the brief)

- `normalizeHandle` — `../../domain/handle`, copied from `follow-user.ts`. Matches.
- `UserRepositoryPort`/`findByHandle` — `../ports/user-repository.port`, method
  exists with signature `findByHandle(handle: string): Promise<UserRecord | null>`. Matches.
- `validate` middleware — `../http/validate`, signature
  `validate(schema: ZodSchema)` storing into `c.get("validated")`. Matches.
- `requireUserAuth`/`resolveViewerId` — `../http/user-auth.middleware`. Matches brief exactly.
- `KeysetCursor`/`encodeKeysetCursor`/`decodeKeysetCursor` — `../../domain/keyset-cursor`. Matches brief exactly, including the strict round-trip check in `decodeKeysetCursor`.

No migration was needed or added — Task 1 already produced the `post` table
and its indexes; this task only added application/HTTP layers.

## Step 10: mutation testing, each restored, real output pasted

### Mutation 1 — `parseBefore` returns `null` instead of throwing

```diff
-  const cursor = decodeKeysetCursor(raw);
-  if (cursor === null) throw new ValidationError("penanda halaman tidak valid");
-  return cursor;
+  const cursor = decodeKeysetCursor(raw);
+  return cursor;
```

```
$ bun test src/routes/posts.test.ts
...
135 |   it("rejects a garbage ?before= with 400 — NOT a silent restart at page 1", async () => {
136 |     const res = await app().request("/users/feed?before=garbage");
137 |     expect(res.status).toBe(400);
                             ^
error: expect(received).toBe(expected)

Expected: 400
Received: 200

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:137:24)
(fail) GET /users/feed > rejects a garbage ?before= with 400 — NOT a silent restart at page 1 [12.69ms]

 25 pass
 1 fail
 52 expect() calls
Ran 26 tests across 1 file. [4.19s]
```

Caught. Restored (confirmed by re-reading the file after the `Edit` reverted it).

### Mutation 2 — delete the `tab === "mengikuti" && viewerId === null` guard

```diff
     const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
-    if (tab === "mengikuti" && viewerId === null) {
-      return c.json({ error: "masuk untuk melihat kiriman yang Anda ikuti" }, 401);
-    }
     const page = await deps.listFeed.execute({ tab, viewerId, limit, before });
```

```
$ bun test src/routes/posts.test.ts
...
unhandled error: Error: ListFeed: mengikuti requires a viewer; the route must reject first
109 |     expect(res.status).toBe(200);
110 |   });
111 | 
112 |   it("tab=mengikuti with NO Authorization header is 401", async () => {
113 |     const res = await app().request("/users/feed?tab=mengikuti");
114 |     expect(res.status).toBe(401);
                             ^
error: expect(received).toBe(expected)

Expected: 401
Received: 500

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:114:24)
(fail) GET /users/feed > tab=mengikuti with NO Authorization header is 401 [10.00ms]

 25 pass
 1 fail
 52 expect() calls
Ran 26 tests across 1 file. [4.48s]
```

Caught (as a 500 rather than a 401, but still red — `ListFeed`'s own defensive
`throw new Error(...)` is what fires, since the route no longer intercepts
`viewerId === null` before calling it). Restored.

### Mutation 3 — `MAX_POST_BODY_LENGTH` 1000 → 999 in `packages/shared`

```diff
-export const MAX_POST_BODY_LENGTH = 1000;
+export const MAX_POST_BODY_LENGTH = 999;
```

```
$ bun test src/application/use-cases/write-post.test.ts src/routes/posts.test.ts
...
src/routes/posts.test.ts:
 97 |   it("accepts a body of exactly 1000 characters", async () => {
 98 |     const a = app();
 99 |     const token = await tokenForValidUser(a);
100 | 
101 |     const res = await createPost(a, token, "a".repeat(1000));
102 |     expect(res.status).toBe(201);
                             ^
error: expect(received).toBe(expected)

Expected: 201
Received: 400

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:102:24)
(fail) POST /users/posts > accepts a body of exactly 1000 characters [145.98ms]

src/application/use-cases/write-post.test.ts:
72 |     await expect(
73 |       new CreatePost(posts).execute({ authorId: AUTHOR, body: "a".repeat(1001) })
74 |     ).rejects.toBeInstanceOf(ValidationError);
75 |     await expect(
76 |       new CreatePost(posts).execute({ authorId: AUTHOR, body: "a".repeat(1000) })
77 |     ).resolves.toBeDefined();
                    ^
error: 

Expected promise that resolves
Received promise that rejected: Promise { <rejected> }

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/application/use-cases/write-post.test.ts:77:16)
(fail) CreatePost > refuses a body over the limit — asserted against the LITERAL 1000 [0.52ms]

 33 pass
 2 fail
 63 expect() calls
Ran 35 tests across 2 files. [4.11s]
```

Caught, twice over, both in `apps/api` (the use-case test the brief specified,
and the route test's own "exactly 1000 characters" boundary check). The
`apps/web` half of this mutation does not exist yet — noted per the brief,
and correctly not chased: `MAX_POST_BODY_LENGTH` has no consumer in
`apps/web` until Task 5 builds the composer. Restored.

All three mutations restored; confirmed green afterward (see final verification below).

## On "which mutation survives" — none did

All three of Step 10's specified mutations were caught (went red) on the first
try, with no vacuous test involved: each failure is a real assertion on the
route/use-case actually exercising the mutated code path, not a coincidental
side-effect. No proof-test-passes-with-bug-reintroduced case was found, and no
mutation needed a second iteration to catch. This differs from Task 1's
report, which did hit one of each — I looked for the same shape here
deliberately and did not find it.

## Final verification (after all mutations restored)

```
$ bun run typecheck
$ bun run --workspaces typecheck
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0

$ bun run test
@diudara/shared test:  82 pass / 0 fail — Ran 82 tests across 4 files. [38.00ms]
@diudara/worker test:  38 pass / 0 fail — Ran 38 tests across 3 files. [124.00ms]
@diudara/web test:  514 pass / 0 fail — Ran 514 tests across 40 files. [3.76s]
@diudara/api test:  2029 pass / 0 fail — Ran 2029 tests across 139 files. [56.62s]
```

No `(fail)` lines in the final run (the `(fail)` lines pasted above under Step
10 are from the three deliberate, since-reverted mutations — captured verbatim
before reverting, per instructions).

## Concerns / notes for the next task

- **Nothing blocking.** Every import path the brief told me to double-check
  matched the real files exactly; no migration was needed (confirmed — Task 1
  already shipped the `post` table, its indexes and its repository); no
  brief content had to be second-guessed or deviated from.
- **`apps/web` half of mutation 3 is genuinely not testable yet** — flagging
  per the brief's own instruction, to be re-run at the end of Task 5 once the
  composer exists and reads `MAX_POST_BODY_LENGTH`.
- **Mount order in `app.ts`**: ~~I mounted `postRoutes` before `userRoutes`...
  I checked this is safe rather than assumed it~~ — **THIS WAS WRONG.** I did
  not actually check it; I reasoned about it incorrectly (missing that a
  request path can satisfy one router's STATIC segment using the OTHER
  router's dynamic `:handle`/`:id` value, e.g. `/by-handle/posts` matches
  both `userRoutes`' literal `/by-handle/:handle` and `postRoutes`' literal
  `/:handle/posts`) and wrote a test that could not have caught the mistake
  even if I had run it against the real app. See **Fix round 1, C1/C2**.
- **`routes/posts.ts` deviates cosmetically from the brief's snippet** by
  typing its `deps` parameter as `Pick<Dependencies, "userTokenIssuer" |
  "userRepository" | "createPost" | "editPost" | "deletePost" | "listFeed" |
  "listUserPosts">` rather than the full `Dependencies` — this matches
  `userRoutes`'s own idiom in `routes/users.ts` (which the brief said to
  copy) more closely than the brief's inline snippet did. Behaviourally
  identical.

## Fix round 1

Review verdict on the initial submission: **spec ❌**, C1, C2, I3, I4, I5, and
two Minors. What verified clean and was NOT touched in this round: the auth
split in both directions (including a garbage token degrading to anonymous
rather than 500), 403 arriving as a 403 status code, idempotent delete distinct
from a never-existed 404, the wire key set on all three post-returning routes,
and all three Step-10 mutations reproducing exactly as reported.

### C1 — mounting `postRoutes` before `userRoutes` shadows two real routes

**Confirmed exactly as reported.** `domain/handle.ts`'s pattern
(`/^[a-z0-9_]{3,30}$/`) has no denylist, so a user can register the handle
`posts`. With `postRoutes` mounted first, `GET /users/by-handle/posts` was
captured by `postRoutes`' `GET /:handle/posts` (handle="by-handle", a route
that always 404s since no user is named "by-handle") instead of `userRoutes`'
`GET /by-handle/:handle` (handle="posts"); `DELETE /users/posts/follow` was
captured by `postRoutes`' `DELETE /posts/:id` (id="follow", not a uuid, which
used to 500 — see I3) instead of `userRoutes`' `DELETE /:handle/follow`.

**Fix:** swapped the two `app.route("/users", ...)` lines in `app.ts` —
`userRoutes` now mounts first, `postRoutes` second. Rewrote the comment above
them to state the real mechanism instead of the false claim (see C2).

### C2 — the report's claim was untrue, and so was the code comment

**Confirmed.** Both the round-1 report and the `app.ts` comment claimed no
route in either router shares a literal shape with a route in the other, and
that mount order is therefore not load-bearing. Both statements are corrected
in place above (not just appended past) — see the struck-through passages
under "Three things the brief called out, verified" item 2 and under
"Concerns / notes for the next task" above.

The round-1 test (`routes/posts.test.ts`'s "two routers on one prefix" block)
built its **own** throwaway Hono app in the swapped order and asserted only
`/:handle/posts` and `/:handle/followers` — two shapes that never collide in
either mount order — so it could never fail from a real `app.ts` regression,
which is exactly why the reviewer's swap-and-run-the-suite probe passed
2029/0 despite the real defect being present.

**Fix:** rewrote the test to drive requests through `app()` (`createApp(bootstrap())`
— `app.ts`'s own exported instance), registering a real user with the handle
`posts` and proving `GET /users/by-handle/posts` resolves that user's profile
and `POST`/`DELETE /users/posts/follow` both reach `userRoutes`' follow
endpoints rather than being captured by `postRoutes`.

**Proof the new test goes red when the two `app.route("/users", ...)` lines
are swapped back** (real output, `app.ts` temporarily reverted to the C1 bug,
then re-fixed immediately after capturing this):

```
$ bun test src/routes/posts.test.ts -t "two routers"
bun test v1.3.11 (af24e281)

src/routes/posts.test.ts:
[test] isolated run: database diudara_test_1787014834419_64901_ufim5f (set DIUDARA_TEST_DB_ISOLATION=off to run against DATABASE_URL and keep the rows)
353 | 
354 |     // Must resolve userRoutes' GET /by-handle/:handle with handle="posts" —
355 |     // NOT postRoutes' GET /:handle/posts with handle="by-handle", which
356 |     // would 404 (no user is named "by-handle").
357 |     const profile = await a.request("/users/by-handle/posts");
358 |     expect(profile.status).toBe(200);
                                 ^
error: expect(received).toBe(expected)

Expected: 200
Received: 404

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:358:28)
(fail) two routers on one prefix: userRoutes must be mounted before postRoutes > a handle equal to postRoutes' own literal segment ('posts') does not shadow userRoutes' by-handle lookup or follow/unfollow [327.77ms]

 0 pass
 24 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [736.00ms]
```

Confirmed passing again with the correct order restored:

```
$ bun test src/routes/posts.test.ts -t "two routers"
bun test v1.3.11 (af24e281)

src/routes/posts.test.ts:
[test] isolated run: database diudara_test_1787014843799_64913_e3hbj2 (set DIUDARA_TEST_DB_ISOLATION=off to run against DATABASE_URL and keep the rows)

 1 pass
 24 filtered out
 0 fail
 6 expect() calls
Ran 1 test across 1 file. [771.00ms]
```

### I3 — a malformed post id 500s

**Confirmed.** `DELETE /users/posts/not-a-uuid` (or `PATCH`) reached
`ownershipOf`, which queries a uuid column; Postgres threw and the request
500'd.

**Fix:** added `validateParams(z.object({ id: uuidParam }))` to both the
`PATCH /posts/:id` and `DELETE /posts/:id` routes, the same idiom
`routes/communities.ts`'s `/:id` already uses. A malformed id now 400s before
any repository call; a well-formed but unknown uuid still reaches the use
case and 404s there (pinned separately: "404s a well-formed uuid that never
existed").

**Mutation proof** (removed `validateParams(postIdParams)` from both routes,
ran the two new "rejects a malformed (non-uuid) :id" tests):

```
$ bun test src/routes/posts.test.ts -t "malformed"
bun test v1.3.11 (af24e281)

src/routes/posts.test.ts:
[test] isolated run: database diudara_test_1787015058173_65162_au4az8 (set DIUDARA_TEST_DB_ISOLATION=off to run against DATABASE_URL and keep the rows)
unhandled error: Error: Failed query: select "id", "author_id", "deleted_at" from "post" where "post"."id" = $1: invalid input syntax for type uuid: "not-a-uuid"
320 |     const res = await a.request("/users/posts/not-a-uuid", {
321 |       method: "PATCH",
...
error: expect(received).toBe(expected)

Expected: 400
Received: 500

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:325:24)
(fail) PATCH /users/posts/:id > rejects a malformed (non-uuid) :id with 400, not a 500 [200.59ms]
unhandled error: Error: Failed query: select "id", "author_id", "deleted_at" from "post" where "post"."id" = $1: invalid input syntax for type uuid: "not-a-uuid"
337 | 
338 |     const res = await a.request("/users/posts/not-a-uuid", {
339 |       method: "DELETE",
...
error: expect(received).toBe(expected)

Expected: 400
Received: 500

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:342:24)
(fail) DELETE /users/posts/:id > rejects a malformed (non-uuid) :id with 400, not a 500 [144.49ms]

 0 pass
 29 filtered out
 2 fail
 2 expect() calls
Ran 2 tests across 1 file. [764.00ms]
```

Both reproduced the exact 500 the review measured. Restored; both tests pass again.

### I4 — the probe-row boundary is untested

**Confirmed.** Mutating `post-views.ts`'s `rows.length > limit` to `>= limit`
left `apps/api` green at 2029/0.

**Fix:** added two tests to `post-views.test.ts`: an exactly-`limit`-rows page
(no probe row attached) must have `nextCursor === null`, and a `limit + 1`
page's probe row (deliberately containing a body string that must never
appear in output) must never reach `page.posts`.

**Mutation proof** (`rows.length > limit` → `>= limit`):

```
$ bun test src/application/use-cases/post-views.test.ts
bun test v1.3.11 (af24e281)

src/application/use-cases/post-views.test.ts:
[test] isolated run: database diudara_test_1787015087391_65206_wpx6v3 (set DIUDARA_TEST_DB_ISOLATION=off to run against DATABASE_URL and keep the rows)
61 |     const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
62 | 
63 |     const page = toFeedPage([row, second], 2);
64 | 
65 |     expect(page.posts).toHaveLength(2);
66 |     expect(page.nextCursor === null).toBe(true);
                                          ^
error: expect(received).toBe(expected)

Expected: true
Received: false

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/application/use-cases/post-views.test.ts:66:38)
(fail) toFeedPage > an EXACTLY full page (no probe row) is the last page — nextCursor stays null [1.07ms]

 6 pass
 1 fail
 14 expect() calls
Ran 7 tests across 1 file. [376.00ms]
```

Caught. Restored.

### I5 — the route and the use case disagree about what "1000 characters" means

**Confirmed.** `routes/posts.ts` ran Zod `.max(MAX_POST_BODY_LENGTH)` on the
RAW body; `write-post.ts`'s `requireBody` trims first — so a 1000-character
body with surrounding whitespace was accepted by the use case and rejected by
the route.

**Fix:** changed the schema to `z.string().trim().max(MAX_POST_BODY_LENGTH)`
— deliberately with NO `.min(1)` on the schema, so an empty or whitespace-only
body is not rejected here with a raw English Zod message; it reaches
`requireBody`, which is the sole authority for emptiness and answers in
Bahasa Indonesia. Added a test with exactly 1000 significant characters plus
surrounding whitespace (1004 raw characters).

**Mutation proof** (reverted the schema to `z.string().max(MAX_POST_BODY_LENGTH)`,
no trim):

```
$ bun test src/routes/posts.test.ts -t "surrounding whitespace"
bun test v1.3.11 (af24e281)

src/routes/posts.test.ts:
[test] isolated run: database diudara_test_1787015126214_65240_2zwys0 (set DIUDARA_TEST_DB_ISOLATION=off to run against DATABASE_URL and keep the rows)
107 |   it("accepts exactly 1000 characters plus surrounding whitespace — the route and the use case must agree", async () => {
108 |     const a = app();
109 |     const token = await tokenForValidUser(a);
110 | 
111 |     const res = await createPost(a, token, `  ${"a".repeat(1000)}  `);
112 |     expect(res.status).toBe(201);
                             ^
error: expect(received).toBe(expected)

Expected: 201
Received: 400

      at <anonymous> (/Users/bellinnn/Documents/projects/diudara/.worktrees/posts/apps/api/src/routes/posts.test.ts:112:24)
(fail) POST /users/posts > accepts exactly 1000 characters plus surrounding whitespace — the route and the use case must agree [197.37ms]

 0 pass
 30 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [639.00ms]
```

Reproduced the exact 400 the review measured. Restored.

### M6 — three missing route tests

Added all three, driven through the real app:

1. `DELETE` of a well-formed uuid that never existed → 404 (`DeletePost`'s
   `ownershipOf` returns `null` → `NotFoundError`).
2. `?before=garbage` on `GET /users/:handle/posts` → 400 (this endpoint calls
   the same `parseBefore` as `/users/feed`, but had no test of its own).
3. A full pagination round trip: create 3 posts, `?limit=2` page 1 returns the
   2 newest with a non-null `nextCursor`, `?limit=2&before=<that cursor>`
   returns the 3rd (oldest) with `nextCursor: null` — the first test in this
   task to actually drive `?before=` end to end over real HTTP rather than
   only asserting the cursor's shape (`post-views.test.ts`) or that the
   repository was asked for `limit + 1` (`read-posts.test.ts`).

### On "which mutation survives" for this round — none did, again

All five fixes (C1/C2 combined as one mount-order fix, I3, I4, I5) were
mutation-proven above, each going red with output matching or closely
matching what the review itself measured, and each restored afterward. No
vacuous test and no bad-mutation-that-happens-to-pass case turned up in this
round either.

### Final verification, Fix round 1

```
$ bun run typecheck
$ bun run --workspaces typecheck
@diudara/shared typecheck: Exited with code 0
@diudara/worker typecheck: Exited with code 0
@diudara/web typecheck: Exited with code 0
@diudara/api typecheck: Exited with code 0

$ bun run test
@diudara/shared test:  82 pass / 0 fail — Ran 82 tests across 4 files. [114.00ms]
@diudara/worker test:  38 pass / 0 fail — Ran 38 tests across 3 files. [201.00ms]
@diudara/web test:  514 pass / 0 fail — Ran 514 tests across 40 files. [3.72s]
@diudara/api test:  2036 pass / 0 fail — Ran 2036 tests across 139 files. [57.22s]
```

No `(fail)` lines in this final run — every `(fail)` line pasted in this
section is from a deliberate, since-reverted mutation, captured verbatim
before reverting.

### Not in scope, recorded and deliberately not fixed

There is no reserved-handle list (`domain/handle.ts`'s pattern has no
denylist). With the mount order corrected, nothing currently breaks because
of it — it is a latent hazard, not an active defect, and `app.ts` already
records the identical gap for community slugs a few lines below the `/users`
mount. It needs a real product decision (existing accounts may already hold a
handle like `posts` or `feed`), so it was not bolted on here.

### Disposition summary

| Finding | Disposition |
|---|---|
| C1 — mount order shadows real routes | Fixed — `userRoutes` now mounts before `postRoutes` in `app.ts` |
| C2 — false claim in report and code comment | Corrected in place in this report (struck through, not just appended past) and in `app.ts`'s comment; test rewritten to exercise the real app and proven to go red on the swap |
| I3 — malformed id 500s | Fixed — `validateParams(uuidParam)` on both `PATCH`/`DELETE /posts/:id` |
| I4 — probe-row boundary untested | Fixed — two new tests in `post-views.test.ts` |
| I5 — route/use-case trim mismatch | Fixed — schema now trims before measuring length |
| M6 — three missing route tests | Added all three |
| Reserved-handle list (recorded, not fixed) | Deliberately deferred — needs a product decision, not a code fix |
