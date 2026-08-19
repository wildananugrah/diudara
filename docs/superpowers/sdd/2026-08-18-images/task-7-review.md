# Task 7 review: `MAX_POST_IMAGES` and `GET /users/limits`

Reviewed at commit `d7038a9` on `feat/images`. Verified by mutation, not by
trusting the implementer's report; every mutation below was applied, run,
observed, and reverted (`git checkout --`), confirmed against a clean
`git status` before writing this file.

## Verdict 1: Spec compliance — ✅

Against §6:

- `MAX_POST_IMAGES` is read from `.env` at bootstrap, defaults to 5, and a
  malformed value throws synchronously from `resolveMaxPostImages` and
  therefore from `bootstrap()` — confirmed by mutation (see below), not just
  read. It cannot become `NaN` and silently reject every upload.
- The route schema (`buildPostBodySchema`, shared by `POST` and `PATCH`) is
  the enforcement point; a request over the cap is a 400 with a Bahasa
  message naming the limit.
- `GET /users/limits` exists, is public, returns `{ maxPostImages }`, does
  not touch the database, and cannot fail in any way tied to config or
  runtime state — it echoes a value `bootstrap()` already resolved and
  validated at process start. This is exactly the "cheap, cannot 500"
  contract §6's fallback design depends on (see judgement call below).

## Verdict 2: Task quality — approved, no findings

No Critical, Important, or Minor findings. Every claim in the implementer's
report was independently reproduced by mutation:

- **Both create and edit are genuinely capped by one shared schema
  instance**, not by parallel copies that happen to agree today. Confirmed
  by two independent single-path mutations (not just "remove the whole
  thing and watch everything redden," which wouldn't distinguish a shared
  schema from two schemas that both happen to enforce the cap):
  - Mutated `POST /users/posts` alone to use an uncapped schema
    (`buildPostBodySchema(999999)`), leaving `PATCH` on the real
    `postBodySchema`. Result: both POST-cap tests reddened
    (`POST /users/posts: a post carrying more than the maximum images is a
    400`, `...the refusal names the limit, in Bahasa`), while the PATCH test
    (`PATCH /users/posts/:id: an edit carrying more than the maximum images
    is ALSO a 400`) stayed green. Reverted.
  - Mutated `PATCH /users/posts/:id` alone the same way, leaving `POST`
    capped. Result: only the PATCH test reddened; both POST tests stayed
    green. Reverted.
  - This is the strongest evidence available that it is one shared
    instance, not two schemas that happen to match: each verb's cap is
    independently load-bearing and independently tested, and the sharing in
    `postRoutes` (`const postBodySchema = buildPostBodySchema(deps.maxPostImages)`
    passed to `validate()` on both routes) is real, not incidental.
- **Malformed `MAX_POST_IMAGES` fails boot loudly.** Mutated
  `resolveMaxPostImages` to strip its throw-and-return-`NaN`-safely guard
  (returning `Number(raw)` unchecked). Both `resolveMaxPostImages >
  refuses a malformed value loudly rather than becoming NaN` and
  `bootstrap() MAX_POST_IMAGES wiring > fails closed on an invalid
  MAX_POST_IMAGES...` reddened. Reverted. Confirms `"banyak"`, `"0"`,
  `"-2"` (and `"1.5"`) are all genuinely rejected, not just asserted to be
  by a test that would pass regardless. Default of 5 when unset is a
  passing baseline test (`bun test` run below), not separately mutated
  (nothing to invert — "unset" has no alternate wrong branch to defeat).
- **`GET /users/limits` is public.** Read directly: `app.get<"/limits">`
  has no `requireAuth` in its middleware chain, unlike every authenticated
  route on the same router (e.g. `/me` takes `requireAuth` as its second
  arg). The covering test sends no `Authorization` header and gets 200.
- **The reserved-handle guard genuinely covers `/limits`.** Independently
  reproduced the implementer's positive control: removed `"limits"` from
  `RESERVED_HANDLES` (route left mounted) and reran
  `users.test.ts -t "every literal /users segment"` — it failed with
  `Received: ["limits"]` against `Expected: []`. Reverted, reran clean.
  The guard is not vacuous and does catch this specific omission.
- **Literal-value discipline in tests.** No test imports
  `MAX_POST_IMAGES`/`DEFAULT_MAX_POST_IMAGES` to assert against itself;
  every assertion uses a literal (`5`, `3`, `"not-a-number"`, six real
  uploaded ids, `"maksimal 5 foto"`). Grepped the three covering test files
  directly to confirm no such import exists.
- **Bahasa refusal names the limit.** `mediaIds.max(maxPostImages,
  \`maksimal ${maxPostImages} foto per kiriman\`)` — wire-tested via a
  literal `"maksimal 5 foto"` substring match, not a re-derivation of the
  constant.
- **`.env.example`** carries `# MAX_POST_IMAGES=5`, commented out, same
  style as the existing `# AI_DAILY_MESSAGE_LIMIT=50` line — a documented
  default, not a secret or a real deployment value, consistent with every
  other numeric limit in that file.
- **Projection stays closed.** Task 7 does not touch `PostView`/
  `toPostView`/`post-views.ts` at all — grepped to confirm; the response
  shape for posts is untouched by this diff, so the `author, body,
  createdAt, editedAt, id, media` projection is not a concern introduced or
  reopened by this task.

Baseline (unmutated) run of the three covering files together:
`bun test src/routes/users.test.ts src/routes/posts.test.ts
src/bootstrap.test.ts` → **311 pass, 0 fail** — matches the implementer's
report exactly. Did not re-run the full API suite per instructions.

## Judgement call: is `GET /users/limits` fragile?

No. Read the handler directly:

```ts
app.get<"/limits">("/limits", (c) => {
  return c.json({ maxPostImages: deps.maxPostImages });
});
```

It is synchronous, touches no database, no external service, and no
optional dependency — `deps.maxPostImages` is a plain `number` that
`bootstrap()` already resolved (and validated) once at process start, before
the HTTP server ever accepts a connection. There is no code path in this
handler that can throw, and nothing it depends on can be "absent" at
request time in a way that wasn't already fatal at boot. This is about as
cheap and unfragile as an endpoint can be, which is exactly what §6's
"the fallback can only be wrong about the button, never block the composer"
contract needs from the server side — a slow or flaky `/users/limits` would
undermine the design even with correct enforcement, and this implementation
gives it nothing to be slow or flaky about. The half of the contract this
task doesn't build (the web's advisory fallback on fetch failure) is
explicitly deferred to Task 8 per the brief and out of scope here.

## Tree state

Confirmed clean after every mutation and at the end of review:
`git status --short` → empty, both in `apps/api/` and at the worktree root.
