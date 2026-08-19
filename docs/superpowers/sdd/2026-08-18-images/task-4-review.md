# Task 4 review — `POST /users/media`, and reserving the `media` handle

Reviewed at commit `1d8f771` (branch `feat/images`, worktree
`/home/wildandev/repo/diudara/.worktrees/images`), against
`.superpowers/sdd/2026-08-18-images/task-4-brief.md`,
`.superpowers/sdd/2026-08-18-images/task-4-report.md`, and
`.superpowers/sdd/2026-08-18-images/review-ca2da15..1d8f771.diff`.

## Verdict 1: Spec compliance — ✅

Everything the brief lists is present and does what it says, nothing extra beyond what was
required (and disclosed):

- `media` added to `RESERVED_HANDLES` (`domain/handle.ts`) and to `isReservedHandle`'s test.
- `UploadMedia.execute({ ownerId, bytes })` returns `{ id, width, height }`; enforces
  `MAX_UPLOAD_BYTES` before `processUpload`; lets `UnsupportedImageError` propagate; writes both
  variants, then inserts the row.
- `mediaRoutes(deps)` → `POST /media`, behind `requireUserAuth`, 201 on success, 401 without auth,
  400 (Bahasa, reusing `image.ts`'s message) on an unsupported file, 400 on a missing `file` field.
- `app.ts` mounts `mediaRoutes` at `/users`, after `userRoutes` (and after `postRoutes`, which the
  report correctly notes is order-independent since neither router's literal segments collide).
- `bootstrap.ts` wires `uploadMedia`; `bootstrap.test.ts`'s two hand-built `Dependencies` fixtures
  updated to compile.

## Verdict 2: Task quality — approved, with findings

### Findings

- **Important — the bytes-before-row ordering is unpinned by any test.** Verified by mutation:
  swapping `media.create` to run before the two `storage.put` calls in `upload-media.ts`, all 7
  tests in `media.test.ts` + `upload-media.test.ts` still pass (0 fail). No test injects a failure
  between the storage writes and the row insert (e.g. asserting no row exists if `put` throws), so
  a future refactor could silently reverse the order — reintroducing the "media id 404s forever"
  failure mode the brief specifically wrote this ordering to avoid — with nothing turning red.
  Mutation restored; tree confirmed clean afterward.

- **Minor — `byteSize`'s meaning (re-encoded `full` size, not the original upload's size) is
  unasserted by any test.** Verified by mutation: changing `byteSize: processed.full.byteLength`
  to `byteSize: input.bytes.byteLength` in `upload-media.ts`, all 7 covering tests still pass.
  The implementer flagged this themselves in the report; I agree it's correct as built (matches
  the schema's own "of the FULL image after re-encoding" comment) but the interpretation is one
  refactor from silently flipping. Mutation restored.

- **Minor — report's test-count claim for `drizzle-media.repository.test.ts` is wrong.** The report
  says "I ran that file and it is still 7/7 green." The file has 4 `it()` blocks (8 `expect()`
  calls); running it gives `4 pass, 0 fail`, not 7/7. (There are 7 `repo.create(...)` call sites in
  that file, which may be what got conflated with "7/7".) The underlying claim — this file is
  unaffected by the port change — is correct and independently reconfirmed (4/4 green), so this is
  a report-accuracy slip, not a code defect.

No Critical findings.

### Security review (untrusted-bytes checklist)

- **Size limit enforced before decode.** Confirmed by mutation: moving the `MAX_UPLOAD_BYTES` check
  to *after* `processUpload` makes the oversized-upload test fail correctly (`UnsupportedImageError`
  instead of the expected `ValidationError`, since an all-zero 10 MB+1 buffer isn't a decodable
  image) — so this ordering is genuinely covered, not just claimed. Mutation restored.
- **File type is decided by the file's own header, never the client.** `domain/image.ts`'s
  `processUpload` calls `sharp(bytes).metadata()` — reads bytes, not `Content-Type`. Confirmed by
  code inspection that neither `routes/media.ts` nor `upload-media.ts` ever reads `file.type` or
  `file.name` (`grep` for `.type`/`.name` in both files returns nothing) — there is no code path
  through which a lying `Content-Type` or filename could matter, independent of the one test that
  happens to exercise this.
- **Caller cannot influence the media id or storage key.** `id = crypto.randomUUID()` is generated
  server-side inside `UploadMedia.execute`; nothing from the request (body, headers, filename)
  reaches it. `MediaStoragePort.put(id, variant, bytes)` composes the key from that id and a
  fixed `"full"|"thumb"` literal only — no caller-supplied string ever reaches the key layout.
- **Auth is real, ownership is server-derived.** `requireUserAuth` 401s on a missing/invalid/
  epoch-stale token; the route reads `ownerId` from `c.get("userId")` (set by the middleware from
  the verified token's user), never from the request body — confirmed by inspection, `media.ts`
  never parses an `ownerId` field.
- **Bahasa errors reuse `image.ts`'s message.** `routes/media.ts` catches `UnsupportedImageError`
  and rethrows `new ValidationError(err.message)` — the same string object from `image.ts`, not a
  second copy. The size-limit message (`TOO_LARGE_MESSAGE` in `upload-media.ts`) is a *new* Bahasa
  string, correctly so: `image.ts` has no existing "too large" message to reuse (it only exports
  the `MAX_UPLOAD_BYTES` constant), and the pattern mirrors `write-post.ts`'s own
  `TOO_LONG_MESSAGE`. Not asserted literally in any test (only `toBeInstanceOf(ValidationError)`),
  which is a very minor gap — the brief's own Step 2 sketch didn't require it either, so not logged
  as a separate finding.

### Reserved-handle guard

Independently re-ran the implementer's positive control: removed `"media"` from
`RESERVED_HANDLES`, ran `bun test src/routes/users.test.ts -t "every literal /users segment"` —
failed with the exact diff the report describes (`- [] / + ["media"]`), because
`routes/users.test.ts`'s guard derives shadowable segments from the real, mounted `app().routes`
(via `createApp(bootstrap())`), which does include `mediaRoutes`' `/users/media`. Restored, reran,
passes. The guard genuinely covers the new route.

### No network reached

`selectMediaStorage` (bootstrap.ts) only returns `S3MediaStorageAdapter` when all five `S3_*` env
vars are set; this worktree's `.env` sets none of them, and `NODE_ENV` is in the relaxed set under
`bun test`, so `route`/`use-case` tests run against `FakeMediaStorageAdapter` — an in-memory `Map`.
Task 2's `refuseUnderTest` guard on the real S3 adapter is never on the exercised code path; nothing
in this diff touches, weakens, or works around it.

### Literal-value assertions / TDD

`media.test.ts`'s format-rejection test asserts the literal Bahasa string
(`"Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."`), not a re-import of the constant —
correct per the rule. The report's documented red-phase (stub `execute` throwing a generic `Error`;
stub `mediaRoutes` returning an empty `Hono()`) is a legitimate way to get first-order red-for-the-
right-reason evidence; combined with my own mutation testing of the size-check ordering (confirmed
above), I'm satisfied the tests fail for their own reasons, not for unrelated ones.

## Ruling verification

**1. The port change (`MediaRepositoryPort.create`'s new optional `id?: string`) — additive,
confirmed.** All 4 existing `DrizzleMediaRepository.create` call sites (in
`drizzle-media.repository.test.ts`) omit `id` and are unaffected — reran that file independently:
4/4 pass (not 7/7 as the report states; see Minor finding above on the report's count, which does
not change the substance of the claim). `grep` across `src` for other `.create(` calls on this
port found none outside that test file and `upload-media.ts` itself, so Tasks 6 and 10 — which
have not landed yet — inherit a strictly wider, backward-compatible signature with nothing to
adapt to. No existing signature moved. Ruling upheld.

**2. `byteSize` = re-encoded full variant's size — correct, and confirmed unpinned.** Matches the
schema comment cited in the report. Confirmed by mutation (above) that no test currently pins this
interpretation; agree it should be logged as a finding (done above, rated Minor since it is
currently correct and the risk is a future silent regression, not a present defect).

## Tree state

`git status --short` clean in both the repo root and `apps/api` after every mutation test; all
mutations (ordering swap, size-check-after-decode swap, `byteSize` swap, `RESERVED_HANDLES` removal)
were reverted with `git checkout --` and independently reconfirmed clean.
