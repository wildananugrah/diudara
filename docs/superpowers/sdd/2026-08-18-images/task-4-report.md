# Task 4 report — `POST /users/media`, and reserving the `media` handle

## What was built

- `apps/api/src/domain/handle.ts` / `handle.test.ts` — `"media"` added to `RESERVED_HANDLES`
  (now six entries), and to the `isReservedHandle` test.
- `apps/api/src/application/use-cases/upload-media.ts` — `UploadMedia`. `execute({ ownerId, bytes })`:
  1. rejects anything over `MAX_UPLOAD_BYTES` with `ValidationError` **before** calling `processUpload`;
  2. runs `processUpload` (Task 3), letting `UnsupportedImageError` propagate unswallowed;
  3. generates a `crypto.randomUUID()`, writes `full` then `thumb` to `MediaStoragePort` under it;
  4. **then** inserts the row via `MediaRepositoryPort.create({ id, ownerId, width, height, byteSize })`,
     `byteSize` being the re-encoded `full` variant's size (matches the schema comment: "Of the FULL
     image after re-encoding, not of what was uploaded").
  5. returns `{ id, width, height }`.
- `apps/api/src/application/use-cases/upload-media.test.ts` — 3 tests against a real
  `DrizzleMediaRepository(db)` and `FakeMediaStorageAdapter`: successful upload stores both variants
  and the row; an oversized input is refused with `storage.size === 0` (proving nothing was decoded
  or stored); an `UnsupportedImageError` from the pipeline reaches the caller, storage still empty.
- `apps/api/src/routes/media.ts` — `mediaRoutes(deps)`. `POST /media` behind `requireUserAuth`,
  reads `file` off a parsed `c.req.formData()`, 400s via `ValidationError` if it is not a `File`,
  calls `UploadMedia.execute`, catches `UnsupportedImageError` and rethrows it as `ValidationError(err.message)`
  so `errorHandler` renders it as a 400 (it is a plain `Error`, not an `AppError`, so it would
  otherwise fall through to the generic 500 branch and lose its Bahasa text) — reuses `image.ts`'s
  existing message, does not invent a second one. Success returns `c.json(result, 201)`.
- `apps/api/src/routes/media.test.ts` — 4 route tests: 201 with `{id, width, height}` on a real PNG;
  401 with no auth; 400 with the literal Bahasa string on a text file lying about its
  `Content-Type`; 400 on a request with no `file` field.
- `apps/api/src/app.ts` — `mediaRoutes(deps)` mounted at `/users`, **after** `userRoutes` (and after
  `postRoutes`, though order relative to `postRoutes` doesn't matter — neither router's literal
  segments collide with the other's).
- `apps/api/src/bootstrap.ts` — `uploadMedia: UploadMedia` added to `Dependencies`, constructed as
  `new UploadMedia(new DrizzleMediaRepository(db), mediaStorage)` right after `mediaStorage` is
  selected.
- `apps/api/src/bootstrap.test.ts` — two hand-built `Dependencies` fixtures ("no database" tests)
  needed a `uploadMedia` field to keep compiling; added an inline hand-written
  `MediaRepositoryPort` fake (all methods throw/return empty — neither test calls `execute`) plus a
  fresh `FakeMediaStorageAdapter()`, mirroring how `mediaStorage` is already faked in those same
  blocks.

## The two Task 1 files I touched, and why — READ THIS FIRST

I modified two files Task 1 owns:

- `apps/api/src/application/ports/media-repository.port.ts`
- `apps/api/src/infrastructure/repositories/drizzle-media.repository.ts`

**What changed:** `MediaRepositoryPort.create`'s input gained one new field, `id?: string`
(optional). `DrizzleMediaRepository.create` passes it into the insert's `.values()` when present
(`...(input.id !== undefined ? { id: input.id } : {})`), and omits the key entirely when absent, so
the column's own `defaultRandom()` fires exactly as it did before.

**This is additive, not a signature change to anything existing callers rely on.** Every current
caller — `drizzle-media.repository.test.ts`'s four `repo.create({ownerId, width, height, byteSize})`
calls — omits `id` and is completely unaffected; I ran that file and it is still 4/4 green with no
edits. Nothing about the return type (`MediaRow`) changed. TypeScript sees a strictly wider
parameter type (one more optional key), so any code written against the old signature still
compiles and behaves identically. Tasks 6 and 10 can keep calling `create` exactly as documented in
Task 1's brief; they only need to know about `id` if they ever want to control it themselves, which
this task's use case is the only current caller to do.

**Why the task was impossible without it.** The brief's own Step 3 states the write order
explicitly: "check the size, run `processUpload`, `put` both variants, **then** insert the row" —
because a row created before its bytes land leaves a media id that 404s forever, whereas bytes
written before an unconfirmed row leaves at worst an unreferenced object (spec §8, the sweep's
job). `MediaStoragePort.put(id, variant, bytes)` and `MediaStoragePort.get`/`Task 5`'s serving route
are all keyed on the media row's own `id` — there is no separate "storage key" concept anywhere in
this codebase (`FakeMediaStorageAdapter` keys its map `${id}:${variant}`, and the port's own
docstring says "callers pass a media id"). For the storage writes to happen *before* the row exists
and still land under the *same* key the row will carry, something has to generate that id before
either write happens, and the only correct answer is the use case, since it is the one thing that
sequences both calls. `MediaRepositoryPort.create` as Task 1 left it always let Postgres assign the
id via `defaultRandom()`, which is only known *after* the row is inserted — the wrong order by
construction. There was no way to satisfy the brief's stated ordering — and the correctness property
behind it, that a media id found in the row always has bytes behind it — without either this change
or generating the id in `UploadMedia` and then re-keying storage after the fact (which I considered
and rejected: it would mean doing the "wrong-key" put, the DB insert, and then a *second* pair of
puts under the real id, tripling storage writes for no benefit and leaving the first pair as
permanent, immediate garbage instead of the accepted "orphan collected by the sweep" case).

I made this change without asking first because it derives directly and unambiguously from
constraints stated in the brief and in the port's/adapter's own existing docstrings, is additive,
and is covered by both the existing repository test (unaffected) and the new `upload-media.test.ts`
(exercises the new path against the real `DrizzleMediaRepository(db)`). I'm flagging it prominently
here per your instruction, since Task 1's port was reviewed and approved as-is and this is exactly
the kind of change you said needs to be surfaced.

## Red phase output

**Use-case test**, run against a stub `UploadMedia.execute` that threw `new Error("not implemented")`:
all 3 tests failed on their own assertion — two on `toBeInstanceOf(ValidationError)` /
`toBeInstanceOf(UnsupportedImageError)` receiving the stub's plain `Error` instead, one on the
success-path assertions never being reached because `execute` rejected. None failed to load.

**Route test**, run against a stub `mediaRoutes` returning an empty `new Hono()`: all 4 tests failed
on `expect(res.status).toBe(...)` — every request hit the empty router and got Hono's default 404,
so `expected 201/401/400, received 404` in every case. None failed to load.

**Route test, second red (message wording):** after wiring the real route, three tests passed
immediately but "rejects a text file..." failed — my first draft asserted
`expect(body.error).toMatch(/JPG, PNG, WebP/)` (the brief's own Step 4 sketch), which does **not**
match the actual message in `image.ts`: `"Format foto tidak didukung. Gunakan JPG, PNG, atau
WebP."` contains `"PNG, atau WebP"`, not `"PNG, WebP"` — the brief's sketch regex, like its
`new DrizzleMediaRepository()` sketch, didn't match the code as it actually stands. Fixed by
asserting the literal string instead (per "tests assert literal values, never the constant they
check").

## The reserved-handle guard, before and after

Before any change, `bun test src/routes/users.test.ts -t "every literal /users segment"` passed
(baseline, run first per Step 1) — at that point no router declared a literal `/users/media`
segment, so the guard had nothing to catch yet.

To confirm what it *would* have caught: after adding `"media"` to `RESERVED_HANDLES` and mounting
`mediaRoutes`, I temporarily removed `"media"` from `RESERVED_HANDLES` again and reran the same
test. It failed:

```
- []
+ [
+   "media",
+ ]
```

i.e. the guard re-derived `"media"` as a shadowable literal segment straight from the app's own
routing table (`app().routes`) and correctly flagged it as present in the route table but absent
from `RESERVED_HANDLES`. I then restored `"media"` to the set and reran — passes again, 0 fail. This
is the guard doing exactly its documented job: it would have failed had Step 1 been skipped, and it
did fail when I simulated skipping it.

## Test counts

- Before this task: (not independently measured; Task 3's baseline was clean per its own report)
- `upload-media.test.ts`: 3/3 pass (new)
- `media.test.ts`: 4/4 pass (new)
- `handle.test.ts`: 18/18 pass (was 17 before the new assertion)
- `drizzle-media.repository.test.ts`: 4/4 pass, unchanged (corrected in fix round 1 below; a prior version of this report wrongly said 7/7)
- `bootstrap.test.ts`: 156/156 pass
- `bun run typecheck`: clean, no errors
- Full `bun test` (apps/api): **2083 pass, 0 fail**, 5582 expect() calls, 145 files, 219.17s, exit
  code 0

## Anything I'm unsure about

- The `id?: string` extension to `MediaRepositoryPort.create` (detailed above) is the one thing I
  want your explicit sign-off on, since it touches Task 1's reviewed surface and Tasks 6/10 both
  consume the same port. To be clear about the shape: it is **purely additive** (new optional
  field, no existing field or return type touched) — nothing about Task 6 or 10's expected calls
  needs to change on account of this.
- `byteSize` in the inserted row is the re-encoded `full` variant's size, not the original upload's
  size — I inferred this from the schema's own comment grouping `width`/`height`/`byteSize` under
  "Of the FULL image after re-encoding, not of what was uploaded," but there's no test elsewhere
  pinning that interpretation, so flagging it in case a later task expected the raw upload size.
- `bootstrap.test.ts`'s two hand-built `Dependencies` fixtures now carry an inline fake
  `MediaRepositoryPort` whose `create` throws "not used" — neither of those two tests exercises
  `uploadMedia`, so this seemed like the minimal, in-pattern fix (mirrors `fakeCreatorRepository`'s
  unused methods a few lines above it) rather than pulling in a real `db`, which those tests are
  explicitly titled around avoiding.

## Commit

`1d8f7713c8c488a50188f62aa4d45f23242f985f` — "feat(api): POST /users/media, and reserve the media handle"

`git status` is clean; nothing outside `apps/api` was touched.

## Fix round 1 (review findings)

Review verdict: spec approved, quality approved with findings — 1 Important, 2 Minor. Reviewer
confirmed by mutation (not just reading) that the size limit reddens if moved after `processUpload`,
that no request field (Content-Type, filename) reaches format detection or the storage key, that the
id is server-generated, and that `ownerId` comes only from the token — and independently re-ran the
reserved-handle positive control with the same result.

### 1. (Important) Bytes-before-row ordering was unpinned

**What changed:** added one test to `upload-media.test.ts`,
`"inserts no row when the storage write fails — pins bytes-before-row"`. It constructs a
hand-written `FailingStorage implements MediaStoragePort` whose `put()` always rejects (never
reaches the network — no `S3MediaStorageAdapter` involved), calls `UploadMedia.execute` with it,
asserts the call rejects, then queries `postMedia` directly (`db.select().from(postMedia).where(eq(postMedia.ownerId, owner.id))`)
and asserts zero rows. If the row were created before the storage write, it would survive the
failed upload and this query would find it.

**Swap-and-confirm-red evidence**, exactly as the reviewer did:

1. Swapped the two blocks in `upload-media.ts` so `media.create` ran before the two `storage.put`
   calls (kept everything else — same `id`, same fields — only the order moved).
2. Ran `bun test src/application/use-cases/upload-media.test.ts`. Output:

   ```
   110 |     await expect(
   111 |       useCase.execute({ ownerId: owner.id, bytes: await fixture("small.png") })
   112 |     ).rejects.toThrow("simulated storage failure");
   113 |
   114 |     const rows = await db.select().from(postMedia).where(eq(postMedia.ownerId, owner.id));
   115 |     expect(rows).toHaveLength(0);
                          ^
   error: expect(received).toHaveLength(expected)

   Expected length: 0
   Received length: 1

         at <anonymous> (/home/wildandev/repo/diudara/.worktrees/images/apps/api/src/application/use-cases/upload-media.test.ts:115:18)
   (fail) UploadMedia > inserts no row when the storage write fails — pins bytes-before-row [75.78ms]

    4 pass
    1 fail
    14 expect() calls
   Ran 5 tests across 1 file. [2.76s]
   ```

   New test went red (found the orphaned row), all 4 other tests in the file stayed green — the
   swap did not disturb anything else, confirming this test is what actually pins the order.
3. Restored `upload-media.ts` via `git checkout -- apps/api/src/application/use-cases/upload-media.ts`
   (the file was already committed from the initial round, so this reverted cleanly to the
   committed version with no diff).
4. Reran the same command: `9 pass, 0 fail` across `media.test.ts` + `upload-media.test.ts` (5 tests
   in this file now, all green).

### 2. (Minor) `byteSize`'s meaning was unasserted

**What changed:** added `"pins byteSize to the re-encoded full variant's size, not the original
upload's"` to `upload-media.test.ts`. Uploads `photo-with-gps.jpg` (measured: 26036 bytes original
→ 3490 bytes re-encoded `full`, via a one-off `processUpload` call before writing the test — sizes
differ by roughly 7×, not by chance), then asserts `row.byteSize` equals the ACTUAL byte length of
what `storage.get(id, "full")` holds, and separately asserts `row.byteSize !== original.byteLength`.
A `byteSize: input.bytes.byteLength` regression would satisfy the first assertion by luck only if
input and re-encoded sizes coincided — which they cannot for this fixture — and would fail the
second assertion outright.

Not separately swap-tested against a live regression (the reviewer's finding was about the
assertion being absent, not about the current behaviour being wrong — already ruled correct), but
the two assertions are individually meaningful: the first pins "must equal what's actually stored",
the second pins "must not equal what came in".

### 3. Report correction

`drizzle-media.repository.test.ts` has **4** tests, not 7 — the original report's "7/7 green" was
wrong (confirmed via `grep -c '^  it(' src/infrastructure/repositories/drizzle-media.repository.test.ts`
→ `4`). Corrected both places it appeared: the "additive, not a signature change" paragraph and the
test-count summary. The substance was unaffected either way — the file's tests are unmodified and
still pass — but the figure itself was wrong and is fixed above.

### Verification run (targeted, not full suite)

```
cd apps/api && bun test src/routes/media.test.ts src/application/use-cases/upload-media.test.ts
```
```
bun test v1.3.14 (0d9b296a)

src/routes/media.test.ts:
[test] isolated run: database diudara_test_1787064621333_176265_emilmg (...)

 9 pass
 0 fail
 23 expect() calls
Ran 9 tests across 2 files. [4.17s]
```

(4 route tests + 5 use-case tests, the two new ones included.)

### Tree state

`git status --porcelain` — clean after the fix commit; the swap-and-restore left no diff since
`upload-media.ts` was already committed and `git checkout --` returned it to that exact committed
state.

### Fix round 1 commit

`c7a9a0af4a601c6380eaa7bfd66da01ac809b9d4` — "test(api): pin bytes-before-row ordering and byteSize's
meaning (Task 4 fix round 1)"
