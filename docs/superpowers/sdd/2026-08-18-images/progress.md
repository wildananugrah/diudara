# SDD ledger — plan: docs/superpowers/plans/2026-08-18-images.md

Phase 4 of the DIUDARA pivot: images.

- Worktree: `/home/wildandev/repo/diudara/.worktrees/images`, branch `feat/images`
- Base: `663a359` (local `main`, four commits ahead of `origin/main`)
- Spec: `docs/superpowers/specs/2026-08-18-images-design.md` — read, and the binding authority
- Baseline before Task 1: **2819 pass / 0 fail** (shared 82, worker 38, web 654, api 2045)

**The worktree was created with `git worktree add`, not the native tool, deliberately.** `EnterWorktree`
has no `worktree.baseRef` setting configured, so it defaults to `fresh` = `origin/main`, which is four
commits behind and does **not contain this plan or its spec**. The native tool would have produced a
worktree that could not read its own instructions.

**The project owner is running the Phase 3 browser gate against the main checkout while this executes.**
That is the other reason for isolation. `apps/api/.env` and `infra/.env` were copied in (git-ignored,
never committed) because the api suite needs a database URL.

## Pre-flight scan

Every pair of tasks sharing a file or an interface, and every task against itself.

| Rows | What was checked | Result |
|---|---|---|
| T1 → T4, T6, T10 | `MediaRepositoryPort`/`MediaRow` produced vs consumed | consistent: `create`/`findById` (T4), `claim`/`listForPosts` (T6), `listUnclaimedBefore`/`deleteById` (T10) all declared in T1's port |
| T2 → T4, T5, T10 | `MediaStoragePort` produced vs consumed | consistent: `put` (T4), `get` (T5), `remove` (T10) |
| T3 → T4 | `processUpload` → `ProcessedImage` | consistent: `{full, thumb, width, height}` used exactly as declared |
| T4 → T5 | both edit `routes/media.ts` and `media.test.ts` | sequential, T5 extends T4; no conflict |
| T2, T4, T7 | all three edit `bootstrap.ts` | sequential, disjoint regions (storage adapter / media deps / `resolveMaxPostImages`) |
| T2, T7 | both edit `.env.example` | disjoint keys (`S3_*` vs `MAX_POST_IMAGES`) |
| T4, T7 | both add to `RESERVED_HANDLES` | `media` (T4) and `limits` (T7); both routes are literal `/users/*` segments matching the handle pattern. Correct, and the route-derived guard catches either being forgotten |
| T4, T6, T8, T9 | the wire shape `{id, width, height}` | identical in all four |
| T6 → **existing tests** | the closed projection | **CONFLICT — F1 below** |
| Each task vs itself | tests specified vs code specified, files created vs later touched | consistent, except **F2 and F3 below** |

### F1 — Task 6 breaks two existing assertions, and the plan does not say so

`apps/api/src/routes/posts.test.ts:94` and `apps/api/src/application/use-cases/post-views.test.ts:18`
both assert the projection is **exactly** `["author","body","createdAt","editedAt","id"]`. Task 6 adds
`media`, so both go red — and an implementer who has only read Task 6's brief will see two failures in
files the brief never mentions.

**Ruling: Task 6 owns updating both assertions to include `media`, and its dispatch carries this.**
*Why:* the closed projection is a Global Constraint and those two tests are what enforce it — widening
them is part of the change, not collateral damage. *Cost if wrong:* nil; the alternative is an
implementer guessing whether a red test it did not write is its business.

### F2 — Task 6's test sketch reaches a fake it cannot reach

Task 6's "removing an image UNCLAIMS it" sketch calls `storage.get(a2, "full")` inside a **route**
test. Route tests build the app with `createApp(bootstrap())`, and `bootstrap()` constructs its own
`FakeMediaStorageAdapter` — the test has no handle on that instance.

**Ruling: split the assertion.** The route test asserts the database state (`postId === null`) through
a separately constructed `DrizzleMediaRepository`, which talks to the same database and needs no
handle on the app's internals. The "bytes survive" half moves to a use-case test where the fake is
injected directly. *Why:* the spec's §11 requirement is that removal is proven not to delete — both
halves still assert that, at the layer that can see them. *Cost if wrong:* one test moves file.

### F3 — `uploadFixture` is defined in one test file and used in another

T4 defines it in `media.test.ts`; T5 reuses it there (same file, fine); T6's sketches call it from
`posts.test.ts`.

**Ruling: T6 defines its own local helper.** *Why:* no test file in this codebase imports helpers from
another test file, and starting now couples two suites. *Cost if wrong:* a few duplicated lines, which
is the cheaper error.

### F4 — noted, not a conflict

T2 requires a missing bucket to **block boot** outside a relaxed `NODE_ENV`, unlike messaging.
`bootstrap.test.ts` asserts no provider-choice log lines today (grepped: 0), so nothing existing
depends on the current behaviour. Flagged to T2's implementer: if an existing bootstrap test does go
red, the fallback condition is what changes, never the test.

## Tasks

### Task 1 — the `post_media` table and its repository

- Dispatched on a standard-tier model: the brief carries the schema, the port and the tests verbatim,
  but `claim`'s transaction is a real implementation decision, so this is not pure transcription.
- BASE `663a359`.
- Dispatch carried three resolutions: the test helpers do not exist and must be written locally; the
  red phase must be recovered by stubbing the port's methods, since a file that fails to LOAD is not a
  red phase; and `claim` nulls the post's current rows before setting the new ones, so no row is ever
  attached to two posts.
- Implementer: `5389990`, **2049 pass / 0 fail** (api +4). Migration `0023_deep_supernaut.sql`.
- Implementer disclosed one deviation from the brief: `DrizzleMediaRepository` takes
  `constructor(db: DatabaseExecutor)` rather than the no-arg shape the brief's test sketch implied.

**RULING — the deviation stands, and the BRIEF was wrong.** Verified against the codebase rather than
taken on trust: `drizzle-follow.repository.ts:25` and `drizzle-post.repository.ts:65` both declare
`constructor(private readonly db: DatabaseExecutor) {}`, and `bootstrap.ts:1593,1609` construct them
by passing `db`. A no-arg repository would have been the only one in the project and would have had to
reach for a module-scope client, which is exactly the coupling the executor parameter exists to avoid
— it is also what lets a caller pass a transaction, which `claim` needs. *Cost if wrong:* nil; this is
the established pattern, confirmed at two call sites. **The plan defect is mine** — my test sketch
wrote `new DrizzleMediaRepository()` without checking the neighbours, and later tasks' sketches
inherit it. Tasks 4, 6 and 10 must construct it with `db`.
- Task reviewer dispatched (mid-tier: small diff, but the migration SQL and `claim`'s semantics need
  real checking). Told to adjudicate the deviation itself, and told not to assume either the
  implementer or the brief is right.
- Review: spec ✅, quality **approved**. 2 Minor, 0 Critical/Important — no fix round.
- The reviewer adjudicated the constructor deviation independently and reached my ruling by a
  stronger route: `DatabaseExecutor`'s own docstring (`db/client.ts:16-25`) names that constructor
  shape as required for unit-of-work composition. It also read `0023_deep_supernaut.sql` directly and
  confirmed the partial index carries `WHERE "post_media"."post_id" is null`, and mutation-tested
  `claim()` live — deleting the release step, and separately swapping it for a delete-dropped-rows
  pattern, both went red. The ordering is pinned, not tautological.

**Task 1: minor (deferred):** the red-phase evidence shows all four tests failing for the SAME reason
(`create()` throwing first) rather than four independently provoked failures. Closed in substance by
the reviewer's own mutation testing, but the report alone did not establish it. Worth remembering as a
report-quality pattern, not a code defect.

**Task 1: minor (deferred), and carried forward:** nothing exercises `claim()` across TWO posts, so a
widened `WHERE` on the release step would not be caught — it could unclaim another post's media and
the suite would stay green. Current code is correct. **Carried into Task 6's dispatch**, which is the
task that exercises `claim` hardest via editing.

**Task 1: complete** (commits `663a359`..`5389990`, review clean).

### Task 2 — the storage port, a fake, and the Biznet adapter

- BASE `5389990`. Dispatched on a standard-tier model: `bootstrap.ts` is ~1700 lines and the
  adapter-selection wiring is integration work, not transcription.
- Implementer: `c2fa86f`, **2065 pass / 0 fail** (api +16). Typecheck clean. Status
  DONE_WITH_CONCERNS — it escalated rather than quietly widening its own scope, which is what the
  dispatch asked for.

**RULING — the wider footprint stands.** The block-boot rule turned 14 PRE-EXISTING tests red across
four files: they simulate a fully-configured production box to exercise some *other* provider's
disabled path, and none of them had S3 config. The implementer added a fake-but-valid five-var S3
config to each test's env INPUT.

Verified before accepting, not taken on trust: `git diff --stat` is **632 insertions, 0 deletions** —
not one line removed anywhere in the branch, so no assertion was altered, weakened, or deleted. The
precedent it cites is real: `TELEGRAM_WEBHOOK_SECRET` joined these same blocks the same way.
*Why the rule stays:* an API that accepts uploads and drops them into memory is worse than one that
refuses to start, and 14 tests needing a new env var is the ordinary cost of adding a required
provider. *Cost if wrong:* the four test files carry five more env lines than strictly needed.

**Unprompted, and better than what the brief asked for:** it also added the five `S3_*` names to
`test-env-preload.ts`'s deletion list, beside `TELEGRAM_BOT_TOKEN`/`FONNTE_API_TOKEN`/`XENDIT_*`.
Without it, a real bucket's credentials sitting in `apps/api/.env` would hand every bare `bootstrap()`
a REAL `S3MediaStorageAdapter` — the one adapter deliberately untested against a live bucket — so the
suite could reach the owner's actual bucket. It closed a credential-reachability hole the brief never
mentioned.
- Review: spec ✅. Quality: **2 Important, 5 Minor, 0 Critical.** Fix round 1 dispatched.

**Both my rulings held, on stronger ground than I had.** The reviewer checked the thing a stat summary
cannot: whether an added env var flipped an existing assertion's MEANING. It found no `REAL_S3_CONFIG`
insertion inside a `.toThrow()` block — all nine sit in `.not.toThrow()` or HTTP-status assertions,
which is the only place that failure mode lives. And the `test-env-preload.ts` change closes a WIDER
hole than its own comment claims: **Bun's `S3Client` reads those same five names as its default
credential source**, so without the deletion a bare client could reach the owner's bucket even without
`selectMediaStorage` handing it over. It also verified the S3 API usage against the 1.3.14 typings and
an offline runtime probe — path-style addressing, private ACL, endpoint normalisation all correct.

Findings sent to fix round 1:

- **I1** (`s3-media-storage.adapter.ts:50-54`) — `remove()`'s `.catch(() => {})` treats expired
  credentials, a 403 and a network failure exactly like success. S3 DELETE is already idempotent, so
  the catch buys nothing and makes a permanent bucket leak permanently silent.
- **I2** (`bootstrap.test.ts:1656-1669` and three route test files) — the nine production-simulating
  blocks now construct a **live** `S3MediaStorageAdapter` pointed at a non-resolving endpoint. Inert
  today because nothing calls it; **Task 4's media routes turn one of them into a real network call
  from the test suite**, and nothing warns. This is the pre-flight's F4 arriving from the direction I
  did not predict.

**RULING on M4 — the port buffers whole images, and that stands.** The reviewer flagged tension with
spec §5.1's word "stream". *Decision:* `Uint8Array` is correct for this phase. Task 3 caps the full
image at 1600px WebP, so an object is a few hundred KB; a streaming port would add backpressure
plumbing to save buffering a fraction of a megabyte. §5.1's "stream" is about **proxying rather than
redirecting** — the property Phase 6 depends on — not about the transport shape inside the API.
*Cost if wrong:* revisit when video arrives, which the parent spec already schedules as its own
project. Carried into Task 4's dispatch so nobody re-litigates it there.

**Task 2: minor (deferred):** M1 — the `.env.example` prose assertions are tautological; the reviewer
deleted the whole 45-line doc block by mutation and the suite stayed green. M2 — `.env.example`
restates the key layout in the same sentence claiming it lives in one file only. M3 — `get()` costs
two round trips and 500s in a TOCTOU window, mitigated because Bun 1.3.14 exports no `S3Error` to
catch. M5 — red-phase evidence covers 3 of 16 new tests; the reviewer substituted 6 mutations, all
caught, so no rework is needed.
- Fix round 1: `414f1d2`. 2065 pass / 0 fail, typecheck clean. **Both findings NOT ADDRESSED.**

**The re-review earned its seat here.** The production code for both fixes is correct — `remove()` now
uses `allSettled` and throws an `AggregateError`, and `refuseUnderTest` fires on the exact three I/O
methods with `DIUDARA_BUN_TEST_RUN` set unconditionally by the preload (the re-reviewer confirmed it
cannot be overridden through `.env` or any `withEnv` helper, so the guard has no false-comfort trap).
**Neither is pinned.** Reverting each fix in turn left all 211 tests across the five covering files
green: the only tests that ever proved these guards were throwaways the implementer deleted.

The signal was visible before the re-review and I flagged it in the dispatch: **2065 pass before the
fix round, 2065 after.** Two behavioural fixes and no new test. A fix proven once by a deleted test is
a fix that regresses tomorrow with nothing to catch it — and I1 exists *because* a failure was silent,
so shipping it unpinned would recreate the exact class of defect it fixes.

**A process failure worth recording.** The re-reviewer stopped mid-mutation with the I1 revert still
applied to the working tree and its `bun test` still running. Had I dispatched Task 3 on the reported
"fix landed" without checking, Task 3 would have been built on a silently un-fixed I1. **Mutation
testing deliberately leaves the tree broken while it runs — `git status` before trusting any agent
that does it.** Tree verified clean afterwards, and both fixes confirmed present at HEAD.
- Fix round 2: `6166217`, **test-only** (+123 lines, 0 production lines changed — the production code
  was already correct, and the round's whole job was to make it regress loudly). 214 pass / 0 fail on
  the covering files.
- Scoped re-review: **both ADDRESSED**, each by an independent mutation naming the test that reddens.
  - I1 → `"throws when a variant's delete genuinely fails"` reddens when `.catch(() => {})` is restored.
  - I2 → `"throws before touching the network, for all three methods"` reddens when `refuseUnderTest`
    is neutered — and it fails in **3.7 ms via connection-refused against `127.0.0.1:1`**, not a hang,
    which is itself the proof that no real network is reachable from the suite.
  - Both assert observable behaviour (`.rejects.toThrow` / `.resolves.toBeUndefined`), not mock call
    counts. Tree verified clean after every mutation, by the re-reviewer and again by me.

**Task 2: complete** (commits `5389990`..`6166217`, review clean after 2 fix rounds).

### Task 3 — the image pipeline

- BASE `6166217`. Dispatched on a standard-tier model: the brief carries `processUpload` verbatim, but
  generating a fixture that genuinely carries EXIF GPS is the part that can silently produce a
  vacuous test, and `sharp` is the project's first native dependency.
- Implementer: `8b1e38f`, **2075 pass / 0 fail** (api +7). Typecheck clean. DONE_WITH_CONCERNS, and
  both concerns were worth raising.

**The EXIF fixture is real, and the implementer nearly shipped one that was not.** `withExif({ GPS:
{...} })` silently produces **no GPS IFD at all** — sharp requires the tags under `IFD3`. It caught
this with a hand-rolled TIFF parser plus `file` as corroboration. I verified independently rather than
taking it on trust: the fixture carries 340 bytes of EXIF and the GPS IFD pointer tag `0x8825` is
present. Without that catch the strip-EXIF test would have passed against an implementation that does
nothing — the precise vacuity the brief's guard assertion exists to prevent, arriving through the one
door the guard could not close (a fixture whose EXIF is *defined* but carries no GPS).

**A PLAN DEFECT, MINE.** The brief's verbatim test asserts `toThrow(/JPG, PNG, WebP/)` while the
brief's verbatim implementation sets the message to `"...Gunakan JPG, PNG, atau WebP."`. The `atau`
breaks the regex — the two halves of my own brief contradict each other. The implementer changed the
MESSAGE to satisfy the test, shipping `"Format foto tidak didukung. Format yang didukung: JPG, PNG,
WebP."`.

**RULING — the copy wins, the test bends.** Revert to `"Format foto tidak didukung. Gunakan JPG, PNG,
atau WebP."` and loosen the regex to tolerate natural Bahasa. *Why:* user-facing Bahasa quality is a
Global Constraint of this project; a regex in my own test sketch is not. "Gunakan ..." tells a person
what to DO, which is the whole job of the sentence, while "Format yang didukung" repeats *didukung*
twice in one message and only restates the problem. The implementer chose correctly between the two
things in front of it — preserve the given test over the given copy — but it was choosing between two
halves of a defect I wrote. *Cost if wrong:* one string and one regex.
- Review: spec ✅. Quality: **2 Important, 1 Minor.** Fix round 1 dispatched.

The reviewer verified a great deal by mutation rather than reading, and reported "no finding" on each
only after breaking it: the EXIF strip is pinned independently on BOTH the full image and the
thumbnail; format sniffing is structurally header-only (no content-type parameter exists to trust);
`deploy.sh`'s sharp check genuinely fails the deploy — **confirmed by renaming the native `.node`
binaries and watching it `exit 1`**, not by reading the script; and the lockfile addition is exactly
sharp plus its real transitive chain.

- **I1 — the copy.** My ruling was confirmed independently, and I asked it to contest me rather than
  agree: "Gunakan JPG, PNG, atau WebP." is an actionable instruction; "Format yang didukung: ..."
  repeats *didukung* twice and restates the problem. Message reverts, regex loosens.
- **I2 — the thumbnail's `withoutEnlargement` is completely untested.** Stripping it from **only** the
  thumb resize left 7/7 green. The no-upscale test asserts `result.width/height`, which is the FULL
  image alone, and the thumbnail test uses the already-large fixture, so nothing anywhere exercises a
  small image through the thumb path. A regression that upscales every small thumbnail would ship in
  silence. The full pipeline's equivalent mutation *does* redden — only the thumb side is bare. This
  is the sharpest kind of finding: a test that looks like it covers a behaviour and covers its twin.

**RULING — the Minor goes into this fix round too, deviating from "minors never enter the loop."**
The EXIF guard asserts the fixture *has EXIF*, not that it has GPS. *Why deviate:* it is one line, in
the same test, in the same file the round already edits, and it closes the exact vacuity vector that
nearly sank this task — a fixture whose EXIF is defined but carries no GPS satisfies the guard while
making the real assertion meaningless. Deferring it means the next person to regenerate that fixture
can silently disarm a privacy test. *Cost if wrong:* one assertion, and a fix round marginally wider
than process prefers.
- Fix round 1: `ca2da15`. 8 pass / 0 fail on the covering file. Typecheck clean.
- Scoped re-review: **all three ADDRESSED**, each verified independently rather than read:
  - Copy → message is exactly `"Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."`, and the
    loosened regex `/JPG,\s*PNG,\s*(atau\s+)?WebP/` **still requires all three format names**. The
    failure mode I named in the dispatch — a regex relaxed into uselessness, satisfying the letter of
    the finding while deleting the guarantee — did not happen.
  - Thumb no-upscale → stripping `withoutEnlargement` from the thumb call only reddens exactly
    `"does not upscale the thumbnail either"` (Expected 200, Received 600); the other 7 stay green.
  - GPS guard → the re-reviewer **constructed a synthetic non-GPS EXIF blob** (Make tag only) and
    confirmed `hasGpsIfdPointer` returns `false` for it, so a fixture regenerated without GPS really
    would fail the guard. Verified, not reasoned.
  - Production diff confirmed message-only: no other pipeline logic moved under cover of a copy fix.

**Task 3: complete** (commits `6166217`..`ca2da15`, review clean after 1 fix round).

### Task 4 — `POST /users/media`, and reserving the handle

- BASE `ca2da15`. Standard tier: multi-file integration (use case, route, mount order, bootstrap deps,
  RESERVED_HANDLES) rather than transcription.
- Implementer: `1d8f771`, **2083 pass / 0 fail** (api +8). Typecheck clean.
- **It stalled twice in a wait-loop**, stopping to "wait for the background test" after that test had
  already finished, with nothing committed. A stopped subagent is not waiting — nothing resumes it
  until the controller sends a message. Checking `pgrep` for the process and `git log` for commits
  costs one call and settles it; a directive resume broke the loop. **Third occurrence of this pattern
  in this plan** (two re-reviewers, one implementer) — treat a "waiting for the background run" reply
  as a stall, always.

**RULING — the port change is accepted.** It added an OPTIONAL `id?: string` to
`MediaRepositoryPort.create`. Additive only; no existing signature moved and no existing caller
changed, so Tasks 6 and 10 inherit nothing they must adapt to. *Why it was unavoidable:* the brief
mandates writing bytes to storage BEFORE inserting the row, and both writes must be keyed on the same
id — so the id has to exist before either happens, which only the use case can arrange. The
alternative would have been inserting the row first, which is exactly the ordering the brief forbids
because it leaves a media id that 404s forever. *Cost if wrong:* one optional parameter.

**The reserved-handle guard was verified with a POSITIVE CONTROL, unprompted.** The implementer
removed `"media"` from `RESERVED_HANDLES` with the route already mounted and confirmed the guard
fails, flagging `media` as an unprotected shadowable segment — then restored it. An absence check with
no presence control is close to vacuous, and this one now has both.

**RULING — `byteSize` is the RE-ENCODED full variant's size, which is what shipped.** The implementer
flagged that it inferred this from the schema comment rather than from a test. *Decision:* correct as
implemented. The column exists to describe what occupies bucket space; the original upload is
discarded and never stored, so its size describes nothing that still exists. *Cost if wrong:* a
figure that overstates nothing and understates nothing anybody can act on. **Carried to the reviewer
as a gap to pin**, since an unasserted meaning is one refactor from silently becoming the other.
- Review: spec ✅, quality approved **with findings — 1 Important, 2 Minor.** Fix round 1 dispatched.

Security checklist confirmed by mutation, not by reading: the size limit reddens a covering test if
moved after `processUpload`; type is decided by `sharp(bytes).metadata()` with **no code path reading
client `Content-Type` or filename**; the id is `crypto.randomUUID()` server-side and no request field
reaches the id or the storage key; `ownerId` comes from `c.get("userId")`, never the body; the Bahasa
rejection message is reused verbatim from `image.ts` rather than duplicated. The reviewer also re-ran
the reserved-handle positive control itself and confirmed `refuseUnderTest` is never on the exercised
path because `selectMediaStorage` correctly hands tests the fake.

- **I1 (Important) — the bytes-before-row ordering is unpinned.** Swapping `storage.put` and
  `media.create` in `upload-media.ts` leaves all 7 covering tests green. This is the brief's own
  load-bearing ordering: the reverse leaves a media id that 404s forever, and nothing would say so.
  The mutation was run and reverted.
- **M1 — `byteSize`'s meaning is unasserted**, exactly as the implementer self-flagged and I predicted
  when I ruled on it: swapping to `input.bytes.byteLength` leaves every test green.
- **M2 — the report miscounts.** It claims `drizzle-media.repository.test.ts` is "7/7 green"; the file
  has 4 tests. The substance holds (the port change affected nothing) — only the number is wrong.

**RULING — M1 joins the fix round; M2 does not.** M1 is one assertion in a file the round already
edits, and it pins a meaning I ruled on in this same session — leaving it unpinned would make my own
ruling unenforceable. M2 is a report-accuracy defect with no effect on shipped code: the implementer
is told to correct it, but it does not gate the task. *Cost if wrong:* one assertion.
- Fix round 1: `c7a9a0a`, **test-only** (+70 lines, 0 production lines). 9 pass / 0 fail on the
  covering files.
- Scoped re-review: **both ADDRESSED**, and both verified past the point where a weaker check stops:
  - Ordering → `"inserts no row when the storage write fails — pins bytes-before-row"` reddens under
    the swap, **and fails for the right reason**: `Received length: 1`, an orphaned row found by
    direct database query rather than an artefact of how the storage error propagates. It injects the
    failure with a hand-written `FailingStorage implements MediaStoragePort` — no network.
  - `byteSize` → `"pins byteSize to the re-encoded full variant's size, not the original upload's"`
    reddens with `Expected: 3490, Received: 26036`. **The fixture is 26,036 bytes original against
    3,490 re-encoded — a 7.5× gap**, so the assertion cannot pass vacuously. This was the specific
    trap I asked about: an assertion whose two sides happen to be close proves nothing, which is the
    same vacuity that nearly sank Task 3's EXIF test.
  - Report figure corrected in both places (lines 54 and 136).

**Task 4: complete** (commits `ca2da15`..`c7a9a0a`, review clean after 1 fix round).

### Task 5 — delivery: `GET /users/media/:id` and `/thumb`

- BASE `c7a9a0a`. Standard tier: two handlers in a file that already exists, but the proxy assertion
  is the one Phase 6's paywall rests on.
- Implementer: `127207b`, **2093 pass / 0 fail** (api +10). Typecheck clean. Three concerns raised,
  all honest, all worth having.

**RULING — the 404 message must be English, not Bahasa.** The implementer used
`"media tidak ditemukan"` and flagged it for a second opinion, which was exactly right. I surveyed the
codebase rather than deciding from memory: **all ten `NotFoundError` messages are English**, including
`"post not found"` from Phase 3. *Why English wins here:* these strings are developer-facing and never
reach a screen — `errorCopy.ts` documents that the web chooses its sentence from the SHAPE of a
failure, never its text, and `no-raw-server-errors.test.ts` enforces it. A lone Bahasa server string
tells the next reader that server strings are user-facing, which is precisely the belief that guard
exists to kill. *Cost if wrong:* one string nobody reads. Goes to the fix round.

**RULING — the `bootstrap.ts` change is accepted.** `MediaRepositoryPort` was not exposed on
`Dependencies` at all, so the route could not be built without it. Additive: the same
`DrizzleMediaRepository` instance, now named and reachable. No behaviour changes for anything outside
these routes.

**Recorded, not a defect: the proxy guarantee is verified by reading plus a header assertion, never
against a real bucket.** The implementer says so plainly — `S3MediaStorageAdapter.get()` fetches the
bytes itself and `MediaObject`'s shape has no URL field, plus the `redirect: "manual"` test asserts no
`Location` header and no bucket hostname. The real adapter self-refuses under test **by design**
(Task 2's guard), so an end-to-end proof is impossible here and belongs to the gate. **Carried to Task
11's checklist:** confirm in DevTools that the image request goes to `/users/media/...` and returns
200, not a 302 to a bucket.
- Review (most capable model, deliberately — this is the task Phase 6 rests on): spec ✅. Quality:
  **1 Critical, 3 Important, 2 Minor.** Fix round 1 dispatched.

- **C1 (Critical) — the proxy property is pinned on `/media/:id` only, not on `/thumb`.** The reviewer
  replaced the thumb handler's body with a 302 to a bucket URL and the suite stayed **12 pass / 0
  fail**. The reason it slips through is the sharpest thing found in this plan so far: **a redirect
  has an empty body, so the size comparison `thumb < full` passes HARDER** — `0 < 634`. A test written
  to distinguish the two variants actively rewards the bug it should catch. Critical rather than
  Important because this is the single property Phase 6's paywall is built on.
- **I1 (Important) — the `CACHE_CONTROL` comment tells Phase 6 something false.** `public` authorises
  the nginx/CDN cache the spec anticipates to replay a gated 200 to anyone **without re-entering the
  handler**, and `max-age=31536000, immutable` outlives a revoked entitlement inside the member's own
  browser. The spec's own sentence carries the qualifier the comment drops: *for media that is not
  gated*. The header is right today; the comment is the defect, and it is the kind that gets believed.
- **I2 (Important)** — the thumb route's missing-bytes 404 guard is unpinned: deleting it leaves 12/12
  green, while the same deletion on the full route reddens a named test. `/thumb` carries only two
  assertions in total.
- **I3 (Important)** — deleting the `findById` row lookup from **both** handlers leaves the suite
  green, because `storage.get` returns null for an unknown id anyway. So the deleted-row-with-
  lingering-bytes case is untested and the row read — the whole justification for putting
  `MediaRepositoryPort` on `Dependencies`, and Phase 6's anchor — reads as dead code to a future
  refactor.
- **M2** — the report miscounts again (claims 16 tests / 12 new; measured 12 / 8). Second miscount
  from this implementer.

**Verified clean by the reviewer, and worth recording as banked:** no code path can leak a bucket URL
or key. `MediaObject` is `{bytes, contentType}` with `contentType` a hardcoded literal in both
adapters, `MediaRow` has no key or url column, there is **zero `c.redirect` in the entire routes
directory**, and `errorHandler` returns `err.message` only for `AppError` and a bare
`"internal server error"` otherwise — so an S3 failure carrying the endpoint hostname cannot reach a
response body. The key layout still lives only in `s3-media-storage.adapter.ts`.

**MY RULING WAS RIGHT AND MY REASONING WAS WRONG — recorded because the reasoning is what gets
reused.** I ruled the 404 message must be English and justified it with "server strings are
developer-facing and English". The reviewer checked and that general claim is **false**: this codebase
ships Bahasa on `ValidationError`/`ConflictError`, including `NO_FILE_MESSAGE = "berkas foto wajib
disertakan"` in *this very file*, added by Task 4. So the implementer was following the local
precedent of the file it was editing — a better-founded choice than I credited. The rule that actually
holds is narrower and absolute: **`NotFoundError` is English at all 54 call sites outside tests.**
Conclusion unchanged, severity Minor.
- Fix round 1: `a007525`. 19 pass / 0 fail (from 12). Typecheck clean.
- Scoped re-review: **all six ADDRESSED**, every one by independent mutation on a named test:
  - C1 → both routes now redden independently under a 302 mutation. The re-reviewer confirmed the
    size-comparison test still does **not** catch the thumb redirect, exactly as predicted — the new
    named PROXIES tests are what catch it.
  - **The WebP magic-number check was verified BY CONSTRUCTION**, which is the part worth copying: the
    re-reviewer built a handler returning JSON `{"url": ...}` with status 200, no `Location` header
    and no bucket hostname — it passes *every check the old test had* and fails only at
    `expect(isWebp(bytes)).toBe(true)`. "Asserts the magic number" and "would reject a JSON body" are
    different claims, and only the second one matters.
  - I1 → the rewritten comment names the condition ("safe only because every post is public today"),
    both mechanisms by which a cache outlives revocation, and the change Phase 6 must make
    (`private, no-store` on the gated path). A comment that merely mentioned Phase 6 would not have
    counted.
  - I2, I3 → each guard reddens its own named test, per route, independently.
  - M1 → `"media not found"`. M2 → counts now match an actual run.
  - The premature-`git checkout --` disclosure checked out: **both wiped pieces are complete at HEAD**,
    no partial restoration. Production diff confined to the message and the comment; no handler logic
    moved under cover of a fix round.

**Task 5: complete** (commits `c7a9a0a`..`a007525`, review clean after 1 fix round).

**Process lesson, recorded for the rest of this plan:** commit BEFORE mutation testing. An implementer
wiped its own uncommitted fixes with `git checkout --` while mutating, and a re-reviewer earlier left
a mutation applied. Both failure modes vanish if the work is committed first and mutations are only
ever reverted against a clean HEAD.

### Task 6 — `mediaIds` on create and edit, and the post projection

- BASE `a007525`. **Most capable model**: the subtlest semantics in the phase (claim/unclaim, the
  one-clause ownership difference between POST and PATCH, `editedAt` on an image-only change), and the
  task most likely to break existing tests.
- Implementer: `f62ec77`, **2135 pass / 0 fail** (api, was 2100). Covering files 54 → 89. Typecheck
  clean. Red phase honest: 54 pass / 35 fail, every failure on its own assertion, no load errors.
- **Task 1's deferred finding is closed.** Widening `claim`'s release `WHERE` now reddens
  `"editing one post never disturbs another post's media"` — and the test puts **both posts under the
  same author**, so only that clause protects post B. An author-scoped test would have passed against
  the bug.

**RULING — omitted `mediaIds` leaves images alone; explicit `[]` strips them. This amends spec §5.2.**
The implementer found a hole I left: §5.2 says `mediaIds` is "the COMPLETE desired list", and read
literally that makes an *omitted* field mean "no images" — so **every pre-existing `PATCH` test, all
of which send `{ body }` alone, would silently wipe a post's photos.** Absent and empty are different
requests and must stay distinguishable, exactly as `bio` already is on `updateProfileSchema`
(`nullable().optional()`, where explicit `null` clears and absent leaves untouched). Pinned at both
layers. *Cost if wrong:* a client wanting to strip images sends `[]`, which is the honest way to say it.

**RULING — the duplicate-id refusal stands**, though the brief never asked for it. One row holds one
`position`, so a repeated id would return a post with fewer images than the client requested: a silent
disagreement between request and result. Refusing is right. *Cost if wrong:* one validation branch.

**RULING — an image-only post stays a 400, and this one is PRODUCT-VISIBLE.** A post still requires
non-empty body text, so "just a photo" is rejected. This is a pre-existing Phase 3 rule the spec never
promised to change, and changing it touches validation, the composer and `PostCard`. *Decision:* out
of scope for this task. *Cost if wrong:* on a phone-first social product this is the single most
likely thing the owner will want reversed — surfaced to them explicitly rather than buried here.

**Carried to Task 7:** `MAX_POST_IMAGES` is not enforced yet — `mediaIds` accepts any length today.
Task 7 must wire a `.max()` into the post schema, which means `postRoutes` gaining that dependency.
The hook is not pre-built.

**OWNER'S DECISION (supersedes my ruling, same outcome): body text stays required — a post is a photo
WITH a caption.** Asked directly, and answered directly. Recorded in spec §7.1 rather than only here,
because it creates a specific trap for Task 8: the instinct when adding a media strip is to widen the
send condition to "text OR image", which would let a caption-less photo be sent and then refused by
the API — converting a rule the UI could enforce quietly into a server error the person must decode.
`canSubmit` stays trimmed-length-above-zero. Both layers already agree today
(`"kiriman tidak boleh kosong"`, and the composer's disabled state measures the trimmed length).
- Review: spec ✅ (§5.2, §8). Quality: **approved — 4 Minor, 0 Critical, 0 Important.** All three
  rulings upheld.
- **The reviewer's process failed but its work did not.** The agent died on an API error while
  returning its summary, having already written a complete 279-line review. Re-dispatching would have
  burned ten minutes re-deriving it. **Check for the artefact before assuming a failed agent produced
  nothing** — and the tree was verified clean, with no mutation left behind by the crash.
- Rulings verified: omitted-vs-`[]` pinned by four tests, two per layer; the duplicate refusal fires
  only on an exact repeat within one request and reddens exactly one test when dropped; and
  `requireBody` is byte-identical apart from hoisting its result into a `const`, running
  unconditionally before any `mediaIds` handling — so the owner's photo-with-caption rule is
  untouched on both create and edit.

**RULING — Minor 2 enters a fix round; 1, 3 and 4 are deferred.** M2: none of the three new Bahasa
refusal messages is asserted anywhere, so **splitting the shared unknown/not-yours message into a
distinct "foto tidak ditemukan" would leave the suite green while re-introducing an existence
oracle** — the same defect class Phase 2's review found in signup, where a taken handle's 409 leaked
whether an email was registered. The code is right today; nothing defends it. One test asserting that
an unknown id and another person's id return the *same* body closes it, and the codebase already
asserts Bahasa strings verbatim in four other places. *Cost if wrong:* one test.

**Task 6: minor (deferred):** M1 — the storage half of the unclaim test cannot fail, since `EditPost`
holds no storage port; the rule is genuinely covered by `media.deletes` and the route test, so the
lines are decoration rather than a hole. M3 — the duplicate refusal is pinned at the use-case layer
only, where every other rule in this task is pinned at both. M4 — the report's mutation table
misnames one reddened test; the reviewer reproduced it and found the property covered but by a
different clause than claimed. Report accuracy, not code.
- Fix round 1 (M2 only): `f49bcbc`, test-only, in `routes/posts.test.ts`. **47 pass / 0 fail** on the
  covering file — verified by me, because the implementer died on a second API error after committing
  but before reporting. Tree clean, commit complete.
- The fix is wider than asked and correctly so: it asserts both bodies **verbatim**, asserts them
  **equal to each other**, and additionally pins the two deliberately DISTINCT refusals — so
  collapsing all three messages into one generic string reddens a test as well as splitting the shared
  one. Placed at the route layer rather than the use-case layer, which is the stronger place for it.

**RULING — no scoped re-review for this round.** Process says a fix round ends with one; process also
says **Minors never enter the loop at all**, and this was a Minor I chose to fold in. Requiring a full
re-review cycle for a bonus fix, during a stretch of API instability, spends more than it protects —
particularly when the diff is 57 test-only lines I have read in full and confirmed green myself.
*Cost if wrong:* the final whole-branch review sees this diff like any other.

**Task 6: complete** (commits `a007525`..`f49bcbc`, review clean, 3 minors deferred).

### Task 7 — `MAX_POST_IMAGES` and `GET /users/limits`

- BASE `f49bcbc`. Mid tier: small surface, but it must wire a `.max()` into the post schema (carried
  from Task 6 — `mediaIds` accepts any length today) and add `limits` to `RESERVED_HANDLES`.

**ROOT CAUSE of the recurring "waiting for the background run" stall, found at Task 7.** The Bash tool
**auto-moves any command past 120 s into the background**. The api suite takes ~215 s, so it can never
complete in the foreground — my instruction to "run it in the foreground" was impossible to obey, and
every agent that tried was auto-backgrounded and then stopped, parking itself. Five occurrences before
anyone reported the mechanism. **The fix is an explicit `timeout` parameter (the tool accepts up to
600000 ms), not an exhortation.** Every remaining dispatch carries that instead.
- Implementer: `d7038a9`, **2148 pass / 0 fail** (api, was 2135). Typecheck clean. All four questions
  answered: cap enforced on **both** create and edit via a shared schema instance; reserved-handle
  guard verified with a positive control (fail → pass); a malformed `MAX_POST_IMAGES` throws and fails
  the boot loudly; `GET /users/limits` is public.
- Review: spec ✅ (§6). Quality: **approved, NO findings.** First task since Task 1 to need no fix round.
- The shared-schema claim was proven rather than accepted: uncapping POST alone reddened exactly the
  two POST tests while PATCH stayed green, and uncapping PATCH alone reddened exactly the PATCH test.
  That rules out "two schemas that happen to agree" as well as a sharing claim that is not real.
  Stripping the throw guard in `resolveMaxPostImages` reddens both the unit test and the `bootstrap()`
  wiring test, so malformed values genuinely fail the boot rather than merely being asserted to.

**Task 7: complete** (commits `f49bcbc`..`d7038a9`, review clean, no fix round).

**THE SERVER SIDE OF PHASE 4 IS COMPLETE.** Tasks 1-7: the table, storage behind a port, the image
pipeline, upload, delivery by proxy, posts carrying media, and the configurable cap. api 2148 pass /
0 fail against a 2045 baseline.

### Task 8 — the web client and the composer

- BASE `d7038a9`. **Most capable model**: the brief is 34 lines and carries test NAMES rather than
  bodies — a gap recorded in the plan's own self-review — so this implementer has to exercise more
  judgment than any so far.
- Implementer: `aac57f1`, `cb9f1a8`, `a5ca4ad`. Web **654 → 716 pass / 0 fail**. Typecheck clean. Red
  phase 49 failures across 3 files, each on its own assertion against loadable stubs.
- **It mutation-tested itself unprompted**: 11 of 12 mutants killed first pass, and chasing the
  survivor (object-URL revocation) turned up a real leak of its own making — previews created after a
  removal were never revoked. Found in self-review, fixed and pinned in `a5ca4ad`.

**RULING — the scope beyond the three briefed files is accepted.** `onSubmit` gained a second
parameter, so `BerandaPage.tsx`, `postOwnerActions.tsx` and `App.tsx` had to change; without that
wiring nothing reaches the API. Additive and disclosed.

**RULING — the limit lives in a module store loaded once at App boot, not per-composer.** Its reason
is better than mine would have been: a per-composer fetch would land as `calls[0]` because React runs
child effects before parent effects, breaking roughly a dozen existing fetch-index assertions written
by earlier phases. *Cost if wrong:* a limit change needs a reload, which for a number that moves once
a year is right.

**FLAGGED TO THE REVIEWER — the two reworded `App.test.tsx` assertions.** `expect(calls.length).toBe(1)`
became `expect(calls.filter(u => u === "/users/me").length).toBe(1)`. The direction is right and it
gained a new `/users/limits` assertion, but the original also guaranteed **no other traffic at all**,
and the filtered form no longer does. Strictly a small loosening, offset by added coverage. Not ruled
by me — the reviewer judges it.

**Judgement calls the thin brief left open**, all disclosed, for the reviewer to weigh: a failed image
does not block Kirim (only landed ids are sent); uploading and failed images count against the limit;
**a multi-pick over the limit is clamped SILENTLY** — the one I like least, since picking eight photos
and having three vanish without a word is confusing on a phone; progress is indeterminate because
`fetch` reports no upload progress without XHR (honest, and correct).
- Review: spec ✅ (§6, §7, §7.1 — each clause dies under mutation). Quality: **2 Important, 7 Minor.**
  Fix round 1 dispatched with I1, I2, M1, M2 and M7.

- **I1 (Important) — every upload failure shows the same unactionable sentence.**
  `describeRequestFailure` collapses all 4xx, including the two failures that will actually happen on
  an Indonesian phone: a file over 10 MB, and **HEIC** — both plain 400s. The person is told "Coba
  lagi", so they retry forever on a cause retrying cannot fix. This is the exact audience the parent
  spec cares about, and §9 of the images spec already names HEIC as the first thing to revisit.
- **I2 (Important) — the silent multi-pick clamp.** The reviewer agreed with my objection and put it
  better than I did: the clamp reports an **event** through **ambient state**. "5/5 foto" and a
  disabled button say *you cannot add more*; they do not say *I dropped three of the eight you just
  picked*, and cannot say which three. The clamp itself stays; the silence costs one `useState` and
  one Bahasa line in the strip's existing alert region.
- **M1** — the two reworded `App.test.tsx` assertions lost more than they had to: test 1 dropped both
  `calls.length` and `calls[0]`, and test 2 dropped "this page load makes no requests at all" — the
  assertion that would have caught the very fetch being added. The reviewer derived and ran the
  stricter form (three runs, 27/0, no flake, because both fetches are issued synchronously in one boot
  effect) and reverted it. It goes into the fix round verbatim.
- **M2** — `busy={submitting}` is unpinned: mutating it to `busy={false}` leaves the suite at 716/0.

**RULING — M3-M6 deferred to the final review.** M3 (`App.test.tsx` boots the limit store without
resetting it — latent, harmless today), M4 (unmount-with-uploads-in-flight is correct, verified by the
reviewer with a throwaway, but untested), M5 (a failed image occupies a limit slot until removed —
deliberate), **M6 — `vite.config.ts`'s `^/users/` comment claims that path is "only reached by
fetch()", which is now false: thumbnails arrive as `<img src>`. Harmless (an `<img>` sends
`Accept: image/*`, so the `bypass` that serves `index.html` to navigations does not fire) but
`vite-proxy-coverage.test.ts` is blind to this new request class. Carried to Task 11's gate: confirm
in DevTools that a thumbnail `<img>` actually loads through the proxy.**

**The store question is settled by evidence, not argument.** With `resetPostImageLimitForTesting`
no-op'd, `apiClient.test.ts` alone fails 3 tests but **6** when `PostComposer.test.tsx` runs first —
so bun genuinely shares the module registry across files, and the reset is the only thing preventing
cross-file bleed.
- Fix round 1: `ff544b1`, `f5f4dc8`. Web **716 → 736 pass / 0 fail**. Typecheck clean. All five items.
  Its own mutation sweep of the new pins killed 7 of 8; the survivor was a gap in its test (removal
  cleared the notice on its own, masking the pick path) and is closed by `f5f4dc8`.

**RULING — both new concerns are accepted and deferred to the final review, with reasons.**

**The format sentence rests on an argument, not a signal.** A 400 from `POST /users/media` is read as
"unsupported format" because the route's only other 400s are a missing file (never sent) and the size
limit (now refused locally against the same 10 MB). The reasoning is written into
`describeUploadFailure`'s docstring, which is the right place for it. *Why accept:* the honest
alternative is a machine-readable error code on the wire — a server change to a task already reviewed
and closed, for a case that is correct today. *Cost if wrong:* if the API ever adds a third 400 to
that route, this sentence starts misdescribing it. **Carried to the final review as the deferred
minor most worth fixing**, and it is cheap there: one code on the wire, one branch on the client.

**`MAX_UPLOAD_BYTES` is now duplicated** between the web copy and `apps/api/src/domain/image.ts`.
*Why accept for now:* drifting low only costs refusing a file the server would have taken, with the
limit named in Bahasa — the failure is safe in the direction it can fail. *But there is an obvious
better home:* `packages/shared`, which already holds `MAX_POST_BODY_LENGTH` for exactly this reason,
read by the composer, the route schema and the use case alike. **Carried to the final review**, which
is where a cross-cutting move like that belongs rather than in a task fix round.
- Scoped re-review: **all five ADDRESSED**, each by mutation on the live tree.
  - I1 → the local size refusal is a **byte-exact match** with the server's `MAX_UPLOAD_BYTES`, and
    removing it reddens 4 tests; the format branch reddens 2 in `errorCopy.test.ts`.
  - I2 → the clamp notice lives in its own `role="alert"`, kept apart from per-image alerts; removing
    the element reddens **9 tests suite-wide**.
  - M1 → both stricter assertions present verbatim; the file ran 3× at 27/0, no flake.
  - M2, M7 → pinned and clean.
  - **The survivor claim was verified the hard way:** the re-reviewer checked out `ff544b1`, applied
    the mutation, confirmed genuine survival, then swapped in only `f5f4dc8`'s added test and
    confirmed the kill — with `PostComposer.tsx` byte-identical across both, isolating test coverage
    from production change.
- **The route-400 argument HOLDS today**, enumerated from source: exactly three 400s — missing file
  (unreachable), over-size (now unreachable, boundary byte-exact), and unsupported format. No
  `bodyLimit`/413 middleware; non-`AppError` throws fall through to 500, never 400. It remains
  reasoning-dependent: nothing inspects *which* 400 occurred, so a fourth would be mislabeled. The
  implementer flagged this accurately against its own work.

**Task 8: complete** (commits `d7038a9`..`f5f4dc8`, review clean after 1 fix round).

### Task 9 — `PostCard`'s media slot

- BASE `f5f4dc8`. Standard tier: smaller than Task 8, but its brief is 17 lines — the thinnest in the
  plan — so the dispatch carries the spec and the constraints instead.
- Implementer: `c3991c2`, web **736 → 744 pass / 0 fail**. Typecheck clean. It also found two fixtures
  in `ProfilePage.test.tsx` missing `media`, which threw inside render and cascaded ~150 unrelated
  failures, and fixed the fixtures rather than adding a fallback — correct for the tests.
- Review: spec ✅. Quality: **1 Important, 2 Minor.**

- **I1 (Important) — a white screen during every deploy of this branch, and the deploy script's own
  ordering creates it.** The reviewer worked the sequence out rather than agreeing with anyone:
  `scripts/deploy.sh` copies the new web bundle into nginx's serving directory **before**
  `pm2 startOrReload`, then polls health for up to 60 s. `media` is introduced on both sides in THIS
  branch — `main`'s `post-views.ts` has no such field, confirmed by reading it. So during that window
  the new bundle talks to the still-running old API, which answers without `media`. `apiClient.ts`
  does no runtime shape validation (`res.json() as T`), the app has **no error boundary anywhere**, so
  `post.media.length` throws inside render and unmounts the tree: a blank `/beranda` and blank profile
  pages for every visitor, plus the same exposure through `PostFeed`'s `prepend`/`replace`.
  **This is categorically different from the fixture bug that surfaced it** — that was test-authoring
  drift with no live analogue; this is version skew the deploy script guarantees.

**RULING — take the render-side guard now; leave `deploy.sh` to the final review.** `post.media ?? []`
costs nothing and converts a blank page into a post without images. Reordering the deploy to reload
the API before swapping the bundle would close the window at its source, but that is a cross-cutting
change to a script this task has no business editing. **Carried to the final review**, alongside the
`packages/shared` move and the format-code-on-the-wire item.

**Task 9: minor (deferred):** spec citation drift in comments and test names (§7 is the composer, not
the feed); no dedicated 2- or 4-image test, which is a CSS-only difference at those counts.
- Fix round 1: `5518781`. Web **745 pass / 0 fail**. Typecheck clean.
- Scoped re-review: **I1 ADDRESSED** — the named version-skew test reddens with exactly
  `TypeError: undefined is not an object (evaluating 'media.length')` when the guard is reverted, and
  **every** read is covered: `.length`, `data-count` and `.map` all read the guarded local binding,
  with one `post.media` reference left in the file (the guarded assignment itself). `PostView.media`
  is still declared required — the guard did not become a licence for the type to lie.
- **Minor NOT ADDRESSED, and deferred rather than pushed a third time.** The citations were corrected
  to the wrong sections: the media slot and "thumbnails are Phase 4's job" both live in §2, not §3 and
  §5.1. The re-reviewer also found the fix made an `apiClient.ts` docstring false — it still claims
  `PostCard` does not write `?? []` over the field.

**RULING — both go to the final review's fix wave, not another round.** These are comment-accuracy
defects with no behavioural weight, and I already folded the citation Minor into one round where it
came back wrong. A third dispatch-plus-re-review cycle to edit comments spends more than it protects,
and the final review has a fix wave that batches exactly this kind of thing. *Cost if wrong:* two
wrong section numbers and one stale sentence survive a few more hours.

**Task 9: complete** (commits `f5f4dc8`..`81e6074`, I1 clean, 3 minors deferred).

### Task 10 — the orphan sweep

- BASE `81e6074`. Standard tier: small surface in `apps/worker`, but the delete ORDER is load-bearing
  and `remove()` now throws on real failures, so a naive pass aborts on the first bad row.
- Implementer: `3b25304`, worker **38 → 50 pass / 0 fail** (`scheduled-passes.test.ts` 18 → 30).
  Typecheck clean. No `apps/api` files touched. It verified the delete-ordering pin itself by flipping
  the implementation, confirming both tests fail, and reverting.
- Two disclosed judgement calls, both going to the reviewer rather than being ruled here: the sweep
  reuses the existing hourly `renewalIntervalMs` rather than adding its own env var; and
  `SweepOrphanMedia` lives entirely in `apps/worker` with fakes and no database, unlike
  `ProcessRenewals`/`ProcessChurn`, which live in `apps/api` with DB-backed tests.
- Review: spec ✅ (§8). Quality: **approved — 2 Important, 1 Minor, none blocking.** Both load-bearing
  behaviours confirmed by independent mutation: flipping the delete order reddens exactly the two
  named tests, and removing the per-row `try/catch` lets the injected `AggregateError` propagate and
  reddens the two pinning "one bad row does not abort the pass". The reviewer also checked the fake
  repository's query semantics against the real partial-index behaviour.

**RULING — no fix round for Task 10; both Importants go to the final review as follow-ups.**

*The composed pair is unproven together.* `SweepOrphanMedia` + real repository + real storage has no
DB-backed test, unlike `ProcessRenewals`/`ProcessChurn`. Both halves ARE tested — the pass with fakes
here, `listUnclaimedBefore`'s real SQL and its partial index in Task 1 — but their agreement is not.
*Why defer:* `apps/worker` has no database test harness at all today, so this is building a new
capability rather than fixing a defect, and the reviewer judged placement correct (the pass has no
domain logic). *Cost if wrong:* a change to `listUnclaimedBefore`'s semantics would leave both suites
green while the sweep collected the wrong rows.

*The interval reuse is sound — ship it.* The reviewer's argument is better than my worry: the bound on
correctness is the **24-hour window**, not the poll cadence. A fourth env var is unused surface today.
The residue is operational surprise — retuning renewals also retunes the sweep — recorded, not fixed.

**Task 10: complete** (commits `81e6074`..`3b25304`, review clean, 3 deferred).

### Task 11 — the gate checklist

**RULING — I write this one myself rather than dispatching it.** It is a documentation deliverable
addressed TO the project owner, and its value is entirely in knowing what the other ten tasks actually
built, which every finding qualified, and which risks reached the end unproven. A fresh subagent would
have to be handed all of that to write it, and would still write it second-hand. *Cost if wrong:* the
final whole-branch review reads it like any other file in the diff.
- Written and committed by me: `docs/superpowers/sdd/2026-08-18-images/gate-checklist.md`. Ten steps,
  ordered so the three genuinely UNPROVEN things come first — the S3 adapter's first contact with a
  real bucket, the proxy guarantee (pinned only against a fake), and the blind-written CSS — rather
  than being buried after routine regression checks. Step 9 covers the deploy window and can only be
  checked DURING a deploy.

**Task 11: complete.**

**ALL ELEVEN TASKS COMPLETE.** Next: the whole-branch review.

## Final whole-branch review — 4 blockers, and my triage was partly wrong

Verdict: **findings must be fixed first.** Suites verified independently: api 2148/0, web 745/0, worker
50/0, guards 12/0, four workspaces typecheck clean. Projection closure mutation-tested (adding
`bucketKey` to `toMediaView` reddens 3 tests). §5.1 enumerated end to end — **no client-reachable path
to a bucket URL or key**; the only appearances are two server-side log lines behind
`redactLinks(safeErrorSummary(...))`.

- **C1 (Critical) — the feed layout is broken at EVERY image count.** `styles.css:1179-1185` overrides
  `width` to `100%` but never sets `height`, so the height presentational hint wins and every box
  renders at the full image's stored pixel height; both axes being definite then makes the
  `aspect-ratio: 1/1` inert. **Measured in headless Chrome** at 390px with real 1200×1600 images: one
  image renders 445×**1600** instead of 445×593; five render a 445×**3204** container instead of
  445×370; a two-image tile measures 1600×1600 pre-load inside a 221px column. **No test could catch
  this — happy-dom computes no layout**, which is exactly why the plan sent the CSS to a browser gate.
- **C2 — and `height: auto` alone is not enough.** `[data-count="1"] img { aspect-ratio: auto }`
  discards the attribute-derived ratio, so the single-image case then reserves **0 px** — the precise
  reflow that `width`/`height` are columns for.
- **I1 (Important) — a 446 KB PNG makes the API allocate 1.4 GB.** Nothing bounds pixel count and
  sharp's default ceiling is 268 MP. Measured with `/usr/bin/time -v`: an 8000² PNG (197 KB) → 754 MB
  RSS; 12000² (446 KB) → **1.41 GB**, both accepted, from files far under the 10 MB cap. Any signed-up
  account can OOM-kill the single API process on demand.
- **I2 (Important) — nginx will 413 nearly every real photo.** No `client_max_body_size` anywhere in
  the repo; nginx's default is 1 MB; phone photos are 2-5 MB. `describeUploadFailure` branches only on
  400, so a 413 gets the generic retry sentence — **the retry-forever loop Task 8's I1 existed to
  kill, reintroduced through a status nobody enumerated.** The gate cannot catch it: step 0 runs vite
  straight to the API, never through nginx.
- **I4 — the sweep/claim race is real.** `deleteById` has no `post_id IS NULL` guard, so a row claimed
  between `listUnclaimedBefore` and `sweepOne` loses both its bytes and its row, and `claim` checks no
  rowcount. Needs a ≥24 h-old unclaimed row — a composer left open overnight. Silent data loss.
- I3 — §10's "rejected before it is read into memory" is not implemented; the body is buffered whole.

**MY TRIAGE WAS PARTLY WRONG, and the corrections are better than the originals.**

- *`MAX_UPLOAD_BYTES` duplication:* I said drift was safe because it only fails low. **Half wrong** —
  drifting **high** is not safe: an oversized file then gets a 400 that `describeUploadFailure` labels
  "unsupported format / HEIC". The duplication is one of the two legs the format-inference argument
  stands on.
- *Format inference:* I deferred it as cheap-later. **It is now load-bearing:** the day a fourth 400
  appears is the day I1 is fixed, because a pixel bound must refuse something — and I2's 413 is
  already a fourth upload failure getting the vaguest sentence.
- *`deploy.sh` ordering:* I framed the risk as the white-screen window. **For this deploy that window
  is empty** — migration 0023 creates `post_media` in the same run, so no post has media during the
  skew. The real argument is **rollback**, where the exposure is worse: `EditComposer` would seed an
  empty strip and `saveEdit` would send `mediaIds: []`, **stripping a post's photos**.
- *DB-backed sweep test:* re-scoped correctly — the untested seam is not `listUnclaimedBefore`'s
  semantics but that `deleteById` is unconditional, which is I4.

## Final fix wave + scoped re-review — all findings ADDRESSED except one, 5 residuals

Fix wave: `65a9b21`, `c9cb71b`, `2d6ca4d`, `8986416`. Re-review re-ran every suite and **every number
the fixer reported reproduces**: api 2165/0 (237 s), web 750/0, worker 52/0, shared 85/0, guards 12/0,
four workspaces typecheck clean.

**The re-review measured rather than read, and caught that BOTH earlier rigs were wrong.** `.user-page`
has 1.25rem padding, so the media column is **350 px at a 390 viewport**, not 390. Shipped geometry,
before → after load, identical in all 20 cases: n=1 350×466.66 (3:4 of the column), n=2 tiles 173²,
n=5 350×291. Pre-fix at `ba15500`: n=1 350×**1600**, n=3/4/5 350×**3204** — the bug reproduced. Zero
overflow at either width.

Pixel bomb, on bytes the re-reviewer built: a 782 KB Adam7-interlaced 16000² PNG took `ba15500` to
**928 MB / 19.5 s and was ACCEPTED**; at `8986416`, **70.6 MB / 0.17 s, REFUSED**. 70 MB is the process
floor, so the refusal is provably pre-decode. Controls: 12 MP and 39.9 MP accepted, 48 MP refused.

## Adjudication of the residuals — no second fix wave, per process

**R1 — the nginx hand-off is PARTIALLY ADDRESSED, and it is the one I would fix first.** Everything the
fixer did is real and the CONTRIBUTING.md section is good. But **the operator runs `scripts/deploy.sh`,
which mentions nginx exactly once — to say it does not touch it.** Nothing on the path a person
actually walks says the word `client_max_body_size`, and the failure is silent server-side by
construction: nginx answers its own 413 and the API logs nothing. *Ruling:* real, load-bearing,
**surfaced to the owner rather than fixed** — process allows one fix wave and it is spent. The
re-reviewer wrote the exact snippet: a non-fatal `sudo nginx -T | grep -q client_max_body_size`
warning after the existing `/health` poll, which already has the precedent of printing a paragraph
pointing at CONTRIBUTING.md.

**R2 — N4, a 409 is never shown and retrying can duplicate a post.** `PostComposer` submits through
`describeRequestFailure`, whose 409 arm is "Coba lagi." Retrying re-sends the same media ids; on
create the post already exists, so the retry **creates a second one**. Same shape as the I2 finding —
a status nobody enumerated reaching the generic retry sentence. Low probability (needs a stale
composer holding claimed ids), user-visible consequence. *Ruling:* the residual most worth fixing
after R1.

**R3 — N1, the 3-image mosaic renders a visible empty quadrant.** Screenshotted by the re-reviewer;
the fix report's "final 193×390 tile" does not exist at any point, because replaced elements do not
`stretch`. A measured one-line fix is in the report and causes no reflow. *Ruling:* cosmetic but
visible on the phone-first surface; gate step 6 will show it.

**R4 — N3, N5, N2: three comment/documentation inaccuracies.** `media.schema.ts` says a 48 MP JPEG is
"0.8×" the bound when it is 1.2× and refused; `PostCard.tsx:88` and its test still describe the OLD
`deploy.sh` ordering that `8986416` inverted — the guards remain right, their stated reason no longer
is; and the CSS comment plus gate step 6 quote bare-container numbers rather than page geometry.
*Ruling:* no behaviour, batch whenever.

**Deliberate residue, recorded in spec §12 rather than a code comment:** a claim landing between the
sweep's re-read and its DELETE still loses the bytes. Closing it requires inverting the
objects-before-row order that Task 4 established for a different reason. The re-reviewer confirmed the
residue is genuinely narrower than what was fixed.
