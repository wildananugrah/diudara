# Task 5 review — media delivery routes (`GET /users/media/:id`, `/thumb`)

Reviewed: `c7a9a0a..127207b` (one commit, 4 files).

## Verdicts

- **Spec compliance: ✅**
- **Task quality: findings** — 1 Critical, 3 Important, 2 Minor.

The code is correct. Every finding below is about what *pins* the code, plus one comment
that tells Phase 6 something false. Nothing here says the shipped handlers misbehave today.

---

## 1. The proxy property (spec §5.1) — the code holds; the tests hold it only halfway

### 1a. Is there any path where a bucket URL or key reaches a response?

I traced every candidate rather than trusting the happy path. **No, and it is structural, not
incidental:**

| Path | Finding |
|---|---|
| `MediaObject` | `{ bytes: Uint8Array; contentType: string }` — no field a URL could travel through. Both adapters hardcode `contentType: "image/webp"`, so even that string is not attacker- or storage-controlled. |
| `MediaRow` | `id, ownerId, postId, position, width, height, byteSize, createdAt`. No key, no url, no bucket column. The repository cannot hand a route a path. |
| Handler headers | Exactly two are set: `Content-Type` (from the hardcoded literal above) and `Cache-Control` (a module constant). Nothing computed. |
| Handler body | `c.body(new Uint8Array(object.bytes), ...)` only. `grep "c.redirect\|\.redirect(" src/routes` → **zero hits in the entire routes directory.** |
| **Error branch** | The one the brief asked me to hunt for. `errorHandler` returns `err.message` **only** for `AppError` subclasses — whose messages here are two hand-written module constants. Every other error, including a `Bun.S3Client` failure whose message could carry `S3_ENDPOINT`, returns the literal `{ error: "internal server error" }` and logs a `redactLinks`-sanitised summary to stderr. A bucket hostname cannot reach a response body through a thrown error. |
| Key layout | Still only in `s3-media-storage.adapter.ts` (`posts/<id>/<variant>.webp`). The only other file that spells a key is `s3-media-storage.adapter.test.ts` — the adapter's *own* test, from Task 2, untouched by this diff. **No route, use case, or new test composes a key.** ✅ |
| `refuseUnderTest` | Untouched. The diff does not go near `s3-media-storage.adapter.ts`. The one place that clears `DIUDARA_BUN_TEST_RUN` is that adapter's own Task-2 test, which stubs the client. No new test reaches the network. ✅ |

So: **the `MediaObject` shape makes a URL structurally impossible, not merely absent today.**
That is the strongest half of the answer, and it is real.

### 1b. Finding C1 (Critical) — the thumb route's proxy property is not pinned at all

**Verified by mutation.** I replaced the thumb handler's `c.body(...)` with:

```ts
return c.redirect(`https://bucket.biznetgio.example/posts/${id}/thumb.webp`, 302);
```

Result: **`12 pass, 0 fail`.** The whole suite stayed green while `/users/media/:id/thumb`
answered a 302 to a bucket URL.

The same mutation on `/media/:id` correctly reddens the named test
`PROXIES: never a redirect, and never a bucket hostname in any header`
(`Expected: 200, Received: 302`). But that test only ever requests the full route.

Why the size test does not catch it: `c.redirect` writes an empty body, so
`thumb.length (0) < full.length (634)` still holds. The one assertion that touches the thumb
route passes *more* comfortably against the bug.

This is Critical by the brief's own standard — the property Phase 6 is built on is unpinned on
one of the two handlers — and the thumb is the *worse* half to leave unpinned: a "preview for
non-members" is precisely the shape a paywall retrofit reaches for, and spec §5.1 names
"not a blurred variant" for exactly that reason.

**Fix:** run the PROXIES assertions against both routes — a `for (const path of ["", "/thumb"])`
loop, or a second named test. Two lines.

### 1c. How to strengthen the in-repo evidence without a live bucket

The implementer's honesty about the limit is correct: the real adapter self-refuses under
`bun test`, so no end-to-end proof exists here, and reading the adapter plus asserting headers is
what remains. But it is **not** as strong as it can be made. Three additions, cheapest first:

1. **C1's fix** — assert the property on both routes. Nothing else matters until this is done.
2. **Assert the body, not only the headers.** The current test greps the serialised *headers*
   for `/biznetgio|amazonaws|s3\./i`. A handler that returned `{"url": "https://..."}` as a JSON
   *body* would pass it. Asserting the first bytes are the WebP magic number
   (`RIFF` at 0..3, `WEBP` at 8..11) proves in one line that the response *is* image bytes and
   therefore cannot be a URL in any encoding.
3. **A source-level guard test**, in the spirit of `apps/web/src/test/no-raw-server-errors.test.ts`
   — read `src/routes/media.ts` and fail on `c.redirect(` or a `Location` header. This codebase
   already uses exactly that mechanism to turn "a reviewer noticed" into "it cannot come back",
   and it is the only construct here that survives a rewrite of the handlers. ~15 lines, and it
   is the strongest thing achievable without a bucket.

---

## 2. Finding I1 (Important) — the `Cache-Control` comment tells Phase 6 something false

The header itself is exactly what the brief mandates and is verified by a named test asserting
the literal string. Today, with every image public, it is fine. The defect is the docstring
above `CACHE_CONTROL`:

> Safe to keep word-for-word once Phase 6 adds an entitlement check in front of these handlers
> […] the check runs BEFORE any bytes are read, so a viewer who fails it never receives a
> response this header could apply to.

That reasoning only considers the viewer who *fails*. Two mechanisms defeat it:

1. **`public` authorises shared caches.** Spec §9 explicitly anticipates "a cache in front of the
   two `GET` routes — nginx or a CDN". A shared cache stores the 200 served to an entitled member
   and replays it to *anyone* who asks for that id, never re-entering the handler where the
   entitlement check lives. The spec's own sentence carries the qualifier the comment drops:
   "**for media that is not gated**".
2. **`max-age=31536000, immutable` outlives revocation.** A member whose subscription lapses keeps
   a usable copy in their browser for a year, and `immutable` tells the browser not to revalidate
   even on reload. So yes — a cached response can outlive a revoked entitlement.

Keep the header. **Rewrite the comment** to say that Phase 6 must split the two cases: ungated
media keeps `public`, gated media must become `private` (and be excluded from any front cache).
Left as written, this is the sentence Phase 6's implementer reads as permission not to think
about it.

---

## 3. Finding I2 (Important) — the thumb route's missing-bytes 404 is unpinned

**Verified by mutation.** Deleting `if (object === null) throw new NotFoundError(...)` from the
**thumb** handler: `12 pass, 0 fail`. The same deletion on the **full** handler correctly reddens
`404s a row whose bytes are missing, rather than 500ing` with
`Expected: 404, Received: 500` and an `unhandled error: TypeError: null is not an object`.

So the full route's guard is properly pinned and genuinely 500s without it — the brief's third
mutation passes. The thumb route's identical guard is defended by nothing.

More broadly, `/thumb` is covered by exactly two assertions: the size comparison and the
malformed-id 400. It has no content-type test, no cache-control test, no missing-bytes test.
The existing missing-bytes test already calls `storage.remove(id)`, which removes **both**
variants — adding one thumb request to it closes this for free.

---

## 4. Finding I3 (Important) — the row lookup, and the whole reason `mediaRepository` was added, is unpinned

**Verified by mutation.** I deleted these two lines from **both** handlers:

```ts
const row = await deps.mediaRepository.findById(id);
if (row === null) throw new NotFoundError(NOT_FOUND_MESSAGE);
```

Result: **`12 pass, 0 fail`.** No test distinguishes the row path from the storage path, because
`storage.get` returns `null` for an unknown id anyway, so `404s an unknown id` passes either way.

Two consequences:

- The **deleted-row-with-lingering-bytes** case is untested. That is not hypothetical: `MediaRepositoryPort`
  has `deleteById`, and Phase 4's sweeper (`listUnclaimedBefore`) exists to use it. If a row is
  removed while its objects linger, the route must 404 — and nothing says so.
- The row read currently looks like dead code to a future refactor: `row` is bound and used only
  for the null check. It is there because **Phase 6's entitlement check reads that row** for
  ownership and tier. Deleting it as "an unnecessary query" would pass CI and quietly remove
  Phase 6's anchor — and with it the justification for the `Dependencies` change this task made.

**Fix:** one test — upload, `await deps.mediaRepository.deleteById(id)` leaving storage untouched,
assert 404. It pins the row read, and it makes `mediaRepository`-on-`Dependencies` load-bearing.

---

## 5. Finding M1 (Minor) — the Bahasa 404 message. **I agree: English.**

I re-ran the survey independently and the ruling is right, but the stated evidence needs two
corrections — both of which the conclusion survives.

**Correction 1 — the count is much larger than "ten".** There are **54** `new NotFoundError(`
call sites outside tests; 50 of them are outside `media.ts`, and **every single one is English**
(`"post not found"`, `"community not found"`, `"user not found"`, `"tier not found"`,
`"subscription not found"`, `"conversation not found"`, `"join request not found"`,
`"unknown transaction"`, …). The four Bahasa ones are the four added by this task. So the
consistency argument is far stronger than stated: 50 to 0.

**Correction 2 — "server strings are English" is false as a general rule, and should not be the
argument.** This codebase does ship Bahasa server strings, just never on `NotFoundError`:
`ValidationError`/`ConflictError` carry them (`"penanda halaman tidak valid"` in `routes/posts.ts`,
`"komunitas ini sedang tidak menerima anggota baru"`, `"kiriman tidak boleh kosong"`) — including
`NO_FILE_MESSAGE = "berkas foto wajib disertakan"` **in this very file**, shipped by Task 4 and
kept by a prior review round. An implementer following the local precedent of the file they were
editing would reasonably reach for Bahasa. The rule that actually holds is narrower: *`NotFoundError`
messages are English, without exception.*

**Why English still wins, on the narrow rule plus one more fact:** `apps/web/src/user/errorCopy.ts`
answers a 404 with `"Data yang Anda cari tidak ditemukan."` chosen from the failure's *shape*, and
`no-raw-server-errors.test.ts` enforces that no screen may print a server string. So
`"media tidak ditemukan"` is copy **no user will ever read** — it buys nothing, and it costs the
one thing the guard exists to protect: the next reader's belief that server strings are not
user-facing. Change it to `"media not found"`.

Severity **Minor**: it is a consistency defect in a string nothing asserts and nobody sees.

---

## 6. Finding M2 (Minor) — the report's test counts are wrong

The report says `media.test.ts` went "4 tests before → 16 tests after (4 `POST` + 12 new)" and
"12 pass in the new describe block". **Measured: 12 tests total in the file — 4 POST + 8 new GET.**
`bun test src/routes/media.test.ts` → `12 pass, 0 fail, 22 expect() calls`. The eight new tests are
real and all pass; the inflation is in the report, not the tree. Worth correcting because the count
is the evidence a reviewer skips re-running the suite on.

---

## 7. Everything else verified clean

- **Malformed id → 400, not a DB 500.** `validateParams(mediaIdParams)` with `uuidParam` runs as
  middleware *before* the handler, so no repository call happens. Both routes have their own named
  test. ✅ (Matches Phase 3's I3 precedent in `routes/posts.ts`.)
- **`Cache-Control: public, max-age=31536000, immutable` present**, asserted as a literal string.
  See I1 for the Phase 6 caveat.
- **Brief mutation 2 (thumb serves `"full"`) is caught.** Changing `get(id, "thumb")` to
  `get(id, "full")` reddens the named `streams the thumbnail, and it is SMALLER than the full image`
  with `Expected: < 3490, Received: 3490`. The brief's size comparison does its job. ✅
- **`bootstrap.ts` is additive and behaviour-neutral.** `new DrizzleMediaRepository(db)` moved from
  an inline argument into a local, the *same instance* is passed to `UploadMedia`, and a new
  `mediaRepository` field was added to `Dependencies` and the return object. Nothing else in
  `bootstrap()` changed — no construction order change, no second connection, no other consumer
  touched. `bunx tsc --noEmit` clean. The `bootstrap.test.ts` churn is a pure de-duplication of an
  inline fake into one module-level `fakeMediaRepository` (−20 lines, same assertions). Accepting
  this as additive and necessary is correct: there was no other way for a route to reach a
  `MediaRepositoryPort`. ✅
- **Tests assert literals, never the constants they check.** `media.test.ts` imports only
  `createApp`, `bootstrap`, `resetDatabase` — nothing from `routes/media.ts`. `"image/webp"` and
  `"public, max-age=31536000, immutable"` are spelled out. ✅
- **Phase 6 comments present on both handlers**, naming the line (`before deps.mediaStorage.get`)
  and stating that a redirect would defeat the gate. The brief asked for this and got it, in
  unusually good prose. ✅
- **No network under test.** Test-run storage is `FakeMediaStorageAdapter`; `refuseUnderTest`
  untouched; nothing disabled or worked around. ✅

## Summary of required changes

| # | Sev | Change |
|---|---|---|
| C1 | Critical | Run the PROXIES assertions against `/thumb` too. |
| I1 | Important | Correct the `CACHE_CONTROL` comment: `public` + a year is not safe under Phase 6 gating. |
| I2 | Important | Add the thumb route's missing-bytes 404 (and, cheaply, its content-type/cache-control). |
| I3 | Important | Pin the row lookup: delete the row, leave the bytes, assert 404. |
| M1 | Minor | `"media tidak ditemukan"` → `"media not found"`. |
| M2 | Minor | Correct the report's 16/12 test counts to 12/8. |

## Hygiene

Five mutations applied and each reverted with `git checkout -- apps/api/src/routes/media.ts`.
Final state: `git status --porcelain` empty, `bun test src/routes/media.test.ts` → 12 pass / 0 fail,
`bunx tsc --noEmit` exit 0. The full api suite was **not** re-run (215s, nothing gained — the
report carries that evidence).
