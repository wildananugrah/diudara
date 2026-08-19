# Task 8 re-review 1 — fix round 1

**Range:** `a5ca4ad..f5f4dc8` (2 commits: `ff544b1` the five fixes, `f5f4dc8` one
follow-up test). Reviewed against `task-8-review.md`'s findings.

**Baseline:** `bun test` in `apps/web`: **736 pass / 0 fail, 45 files, ~18–21 s**.
`bun run typecheck` clean. Every mutation below was applied to the committed tree, run,
and reverted with `git checkout --`. `git status` is clean at `f5f4dc8`.

---

## Verdicts

### I1 — every upload failure showed the same unactionable sentence — **ADDRESSED**

Both halves closed, and both verified by mutation on the live tree:

- **Size, refused locally.** `apiClient.ts` exports `MAX_UPLOAD_BYTES = 10 * 1024 *
  1024`, matching `apps/api/src/domain/image.ts`'s constant and comparison exactly
  (client: `file.size <= MAX_UPLOAD_BYTES` kept; server: `byteLength > MAX_UPLOAD_BYTES`
  refused — the boundary at precisely 10 MB agrees on both sides, and multipart form
  data carries the file's raw bytes, so `file.size` and the server's `byteLength` are the
  same number). The sentence names the limit: `"1 foto tidak ditambahkan — ukuran foto
  maksimal 10 MB."` Mutating the local filter away (`const smallEnough = files;`)
  reddens **4** tests in `PostComposer.test.tsx`, including the one asserting
  `calls.length === 0` for an oversized pick.
- **Format, a distinct actionable sentence.** New `describeUploadFailure` in
  `errorCopy.ts` answers a 400 with `"Format ini tidak didukung. Gunakan JPG, PNG, atau
  WebP — foto iPhone (HEIC) belum didukung."`, genuinely different text from the generic
  `"Permintaan tidak dapat diproses. Coba lagi."` and names both the fix (JPG/PNG/WebP)
  and the actual cause an Indonesian iPhone user will hit (HEIC). Disabling the 400
  branch (`if (false && err instanceof UserApiError && err.status === 400)`) reddens
  **2** tests in `errorCopy.test.ts`.
- `src/test/no-raw-server-errors.test.ts` is green (ran directly, 9/9 across it and
  `no-hanging-dom-assertions.test.ts`). No new file reads `.message` off a caught value;
  `describeUploadFailure` is chosen entirely by `err.status`, never by the wire's text —
  confirmed by reading the diff and by the dedicated test asserting the API's own Bahasa
  400 string never appears on screen.

### I2 — the silent multi-pick clamp — **ADDRESSED**

`MediaStrip` gained `notice: string | null`, rendered as its own `role="alert"`
paragraph below "Tambah foto", separate from any per-image failure alert (a test
confirms both can be on screen and reads them apart by sorted `textContent`).
`PostComposer.attachFiles` computes a Bahasa sentence naming **how many** photos were
dropped and **why** (`"3 foto tidak ditambahkan — maksimal 5 foto per kiriman."`, and
both reasons joined with a space when a pick hits both at once), and clears it on the
next clean pick, on a removal that makes room, and on a successful send.

Mutating the notice element away (`{false ? (...) : null}` in `MediaStrip.tsx`) reddens
**9** tests suite-wide. Mutating the clamp sentence to never be pushed was not
separately re-run (already covered by the element-removal mutation and the report's own
"4 fail" claim for that specific mutation), but the element-removal result alone is
sufficient to confirm the notice is load-bearing and pinned.

### M1 — the two `App.test.tsx` assertions — **ADDRESSED**

Both present **verbatim**, at `src/App.test.tsx:351` and `:382`:

```ts
expect([...calls].sort()).toEqual(["/users/limits", "/users/me"]);
...
expect(calls).toEqual(["/users/limits"]);
```

Ran `src/App.test.tsx` three times: **27 pass / 0 fail** each run, no flake — confirms
both requests are issued synchronously in the one boot effect.

### M2 — `busy={submitting}` was unpinned — **ADDRESSED**

Mutating `busy={submitting}` → `busy={false}` in `PostComposer.tsx` reddens **2** tests
in `PostComposer.test.tsx` — "freezes the strip while the send is in flight, and frees
it again after" and "freezes a failed image's retry too, so the list cannot change
mid-send." Matches the report's claim exactly.

### M7 — stray trailing blank line in `apiClient.ts` — **ADDRESSED**

Confirmed by inspecting the file's tail: it ends `... "DELETE" });\n}\n` with no
trailing blank line.

---

## The implementer's own claim: enumerating `POST /users/media`'s 400s

Read `apps/api/src/routes/media.ts` and `apps/api/src/application/use-cases/upload-media.ts`
(plus `apps/api/src/domain/image.ts` and `apps/api/src/http/error-handler.ts` for how a
thrown error becomes a status code). Every 400 the route can send today:

1. **Missing file** — `routes/media.ts`: `if (!(file instanceof File)) throw new
   ValidationError(NO_FILE_MESSAGE)`. `uploadMedia()` in `apiClient.ts` always calls
   `form.append("file", file)`, so this client can never trigger it.
2. **Over the size limit** — `upload-media.ts`: `if (input.bytes.byteLength >
   MAX_UPLOAD_BYTES) throw new ValidationError(TOO_LARGE_MESSAGE)`, checked before
   `processUpload` runs. Now refused locally (I1 above) at the identical boundary, so
   this client cannot reach it either — verified the two comparisons agree exactly at
   10 MB and that multipart form data preserves raw byte length (no encoding to cause
   drift).
3. **Not a supported image** — `routes/media.ts` catches `UnsupportedImageError` from
   `deps.uploadMedia.execute` and rethrows as `ValidationError(err.message)`.
   `UnsupportedImageError` is constructed with no arguments at both its throw sites in
   `domain/image.ts` (`sharp(bytes).metadata()` throwing, or the format not being one of
   `jpeg`/`png`/`webp`), so the message is always the same fixed string. This covers
   HEIC, corrupt bytes, non-image files, and any other format sharp rejects — one
   message, one 400.

No unrouted error becomes a 400 by accident: `errorHandler` only turns an `AppError`
into its own status or a Hono `HTTPException` into its response; anything else falls
through to a generic 500, never a 400 (`http/error-handler.ts:6–35`). There is no
`bodyLimit`/`413` middleware in this codebase (grepped for it — none found), so a
too-large multipart body is not a route-level concern here either.

**The argument holds today.** Sources 1 and 2 are both structurally unreachable by this
client (1 by construction, 2 by the new local check with a verified-matching boundary),
so the only 400 that can reach `describeUploadFailure` is source 3, a format problem —
exactly what the new sentence claims. This was independently confirmed, not just taken
on the implementer's word.

**It is reasoning-dependent and will silently mislabel a future fourth 400.** Nothing in
`describeUploadFailure`'s 400 branch inspects *which* of the route's 400s occurred; it
infers "format problem" purely from the status code, on an argument that depends on
enumerating every other 400 source and confirming each is unreachable. The day someone
adds a new 400 to this route — e.g. a per-account upload rate check, a dimension floor,
a duplicate-content check — that new failure will render as "Format ini tidak didukung…"
with no signal that the reasoning has gone stale. This is exactly the risk the
implementer flagged against their own work, and the flag is accurate; nothing here makes
it a live finding, since no such fourth 400 exists in the route today.

---

## Spot-checked mutation-sweep claims

Two survivor/kill pairs verified independently, beyond the direct mutation runs above:

- **`describeUploadFailure`'s 400 branch disabled** → 2 fail (report claimed 2; matched).
- **The notice never cleared on a clean pick** (the disclosed survivor). Checked out
  `ff544b1`'s `PostComposer.tsx` and `PostComposer.test.tsx` into the live tree, applied
  the same-shape mutation (`setNotice(sentences.length > 0 ? sentences.join(" ") :
  null)` → `if (sentences.length > 0) setNotice(...)`), and ran against `ff544b1`'s test
  file: **0 fail** — genuinely survived at that commit, as claimed. Restored HEAD's test
  file (with `f5f4dc8`'s new "drops a stale notice on the next clean PICK, with nothing
  removed in between" test) against the same mutated `PostComposer.tsx`: **1 fail** —
  genuinely killed by the follow-up commit. `PostComposer.tsx` itself is byte-identical
  between `ff544b1` and `HEAD` (`git show ff544b1:...` diffed as empty against the
  checked-out copy), so this is a clean before/after comparison of test coverage alone,
  not a confound from an implementation change.

Both spot checks confirm the implementer's mutation log is accurate, not just asserted.

---

## Also checked

- **No new breakage.** Full `bun test` in `apps/web`: 736/0 across 45 files, both before
  and after every mutation-and-revert cycle. `bun run typecheck` clean.
- **Copy is Bahasa and actionable.** `describeUploadFailure`'s "answers in Bahasa on
  every branch" test (regex-checked against English words) passes. The format sentence
  names concrete remedies (JPG/PNG/WebP, and calls out HEIC by name); the size sentence
  names the limit (10 MB); the clamp sentence names the count and the rule. None of the
  three is a bare "coba lagi" — each is more actionable than what it replaced.
- **Literals, not constants.** `errorCopy.test.ts`'s new `describe("describeUploadFailure"
  , ...)` block and `PostComposer.test.tsx`'s new tests assert literal strings (`"1 foto
  tidak ditambahkan — ukuran foto maksimal 10 MB."`, `"2/2 foto"`, etc.), never the
  `MAX_UPLOAD_MB`/`MAX_UPLOAD_BYTES` constants themselves — consistent with the rest of
  this task's test suite.
- **Hazard discipline held.** Every new assertion introduced by this fix round is a
  string, an array of strings (`notices()` maps alerts to `textContent` before
  comparing), a count, or a boolean — no DOM node reaches either side of an assertion
  that can fail. Confirmed by inspection of every new test block in the diff and by
  `no-hanging-dom-assertions.test.ts` staying green.

---

## Final state

`git status` clean at `f5f4dc8`. `bun test` in `apps/web`: **736 pass / 0 fail, 45
files, ~18–21 s**. `bun run typecheck` clean. All mutations applied during this
re-review were reverted with `git checkout --`; nothing was left in the tree.
