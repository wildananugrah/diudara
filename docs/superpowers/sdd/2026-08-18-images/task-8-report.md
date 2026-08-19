# Task 8 — the web client and the composer's media strip

**Status:** done. Commits `aac57f1`, `cb9f1a8`, `a5ca4ad` on `feat/images`.
Web suite **654 → 716** tests, 0 fail, `bun run typecheck` clean, worktree clean.

---

## What I built

### `apps/web/src/user/apiClient.ts`

- **`uploadMedia(file: File)`** — multipart `POST /users/media`, the file under the
  field name the route reads (`form.get("file")`). Goes through `apiFetch`, so a 401
  clears the session in the one place that does that, and resolves `{ id, width, height }`.
- **`authorizedHeaders` no longer labels a `FormData` body `application/json`.** It did
  that for *any* body. `fetch` only generates the `boundary=…` parameter when it is the
  one setting `Content-Type`, so without this fix every upload would arrive as an empty
  form and be refused with `"berkas foto wajib disertakan"` — carrying the file.
- **`mediaThumbUrl(id)`** — `/users/media/:id/thumb`, `encodeURIComponent`'d. The id is
  the only identifier on the wire (spec §4/§5.1); no URL is ever sent by the server.
- **`getLimits()`** — `GET /users/limits`, plus the small store the composer reads:
  `FALLBACK_MAX_POST_IMAGES` (5), `getMaxPostImages()`, `subscribeToPostImageLimit()`,
  `loadPostImageLimit()`, and a test-only `resetPostImageLimitForTesting()` mirroring
  `dashboard/paymentAccount.ts`'s own reset.
- **`mediaIds` on `createPost`/`editPost`** — omitted when the caller passes nothing,
  sent verbatim (including an explicit `[]`) when it does. On `PATCH` those two are
  genuinely different (spec §5.2): `[]` removes every image, omitted leaves them alone.
- **`PostView.media: MediaView[]`** — REQUIRED, not optional, mirroring the API's own
  decision (`toPostView` takes `media` rather than defaulting it). Five test fixtures
  gained `media: []`.

### `apps/web/src/user/MediaStrip.tsx` (new)

Purely presentational: previews, per-image progress, per-image failure with retry,
per-image removal, the hidden picker and "Tambah foto", and an `N/M foto` counter.
It holds no state and starts no request — `PostComposer` owns all of that, which keeps
the §7.1 rule in the component that owns the submit button rather than split across two.

### `apps/web/src/user/PostComposer.tsx`

Hosts the strip above the text box (§7). Each chosen file uploads immediately with a
local object-URL preview; Kirim waits for uploads; failures are per-image; the edit
composer seeds from `initialMedia`; a successful send clears box and strip; a failed
send keeps both.

### Wiring (beyond the brief's file list, and necessary for any of it to reach the API)

- `App.tsx` calls `loadPostImageLimit()` once at boot, beside the existing session repair.
- `BerandaPage.handleCreate(body, mediaIds)` → `createPost(body, mediaIds)`.
- `postOwnerActions.saveEdit(body, mediaIds)` → `editPost(id, body, mediaIds)`, and
  `EditComposer` passes `initialMedia={post.media}`.
- `styles.css` gained the strip's styles. One of them is functional, not cosmetic:
  `.media-strip-picker { display: none }` is what makes "Tambah foto" the visible control.

---

## The red phase

Tests were written first, against stubs (`MediaStrip` returning `null`; `uploadMedia`
resolving an empty `MediaView` without fetching; `loadPostImageLimit` a no-op). The
files LOADED — this was not a compile failure — and each test failed on its own reason:

```
93 pass
49 fail
Ran 142 tests across 3 files.
```

Representative failures:

```
(fail) MediaStrip — what it shows > shows one preview per image, in the order given
TestingLibraryElementError: Unable to find an accessible element with the role "img"

(fail) PostComposer — uploads in flight > Kirim is disabled while an upload is still in flight
TestingLibraryElementError: Unable to find an element by: [data-testid="media-picker"]

(fail) apiClient — mediaIds on create and edit > createPost sends mediaIds in the given order
expect(received).toEqual(expected)
@@ -2,6 +2,3 @@
    "body": "Halo",
-   "mediaIds": [ "media-2", "media-1" ],
  }

(fail) apiClient — the advisory image limit > GETs /users/limits and adopts the server's number
expect(received).toBe(expected)   Expected: 3   Received: 5
```

Four of the limit tests passed against the stub, and honestly so: the stub's behaviour
*is* "keep 5 whatever happens", which is exactly what those four assert. The ones that
distinguish a working implementation from a stub (adopting the server's number, and
notifying subscribers) both failed.

The full red output is in the scratchpad (`red-phase.txt`).

## Mutation testing (after committing, per the brief)

Every one of these was applied to the committed tree, run, and reverted with
`git checkout --`:

| mutation | result |
|---|---|
| `canSubmit` widened to `text OR image` (**the §7.1 trap**) | 2 fail |
| `&& !uploading` removed from `canSubmit` | 1 fail |
| `loadPostImageLimit` rethrows instead of keeping the fallback | 3 fail |
| `FormData` guard removed from `authorizedHeaders` | 1 fail |
| multi-pick no longer clamped to the remaining room | 1 fail |
| a failed upload marks EVERY image | 2 fail |
| a failed SEND clears the strip | 1 fail |
| `initialMedia` dropped from `EditComposer` | 1 fail |
| `saveEdit` drops the ids on the way to `editPost` | 1 fail |
| `handleCreate` drops the ids on the way to `createPost` | 1 fail |
| `App` stops loading the limit at boot | 1 fail |
| **`URL.revokeObjectURL` deleted (either path)** | **0 fail — SURVIVED** |

The survivor was real: nothing checked that local previews are freed. Three tests were
added (`cb9f1a8`), and re-mutating now kills both paths (2 fail and 1 fail respectively).

---

## How DOM nodes were kept out of failing assertions

**No assertion in any new test has a DOM node on either side.** The forms used are:

- `screen.getAllByRole("img").map((img) => img.getAttribute("src"))` — an array of
  **strings**, compared with `toEqual` against string literals.
- `screen.queryAllByRole("progressbar").length` — a **number**.
- `(button as HTMLButtonElement).disabled` — a **boolean**.
- `element.textContent` — a **string**.
- Identity of a *row* is never compared as an object: every callback reports back a
  `key` **string**, and the tests assert `expect(retried).toEqual(["k2"])`.

That is the same discipline `BerandaPage.test.tsx`'s `isNode` enforces — it returns a
short string so a regression prints `"NOT the panel" !== "the panel"`. I did not need
`isNode` itself, because nothing in this task compares two element references; where it
was tempting (which image did the callback mean?), the key string is both safer and a
better assertion. `src/test/no-hanging-dom-assertions.test.ts` stays green, and I
verified the failures I actually hit during development printed in milliseconds.

## The limits fallback, precisely

`App` calls `loadPostImageLimit()` once at boot. That function **cannot fail**: a 500,
an offline phone, a `TypeError` from `fetch`, a proxy error page, or a payload that is
not a whole number ≥ 1 (`"5"`, `0`, `2.5`, `{}`) all leave `FALLBACK_MAX_POST_IMAGES = 5`
in place and resolve. The shape check matters as much as the `catch`: a `0` or a `NaN`
adopted as the cap would disable "Tambah foto" for ever — refusing to attach anything,
which is precisely the failure §6 forbids. The composer therefore always opens, always
offers photos, and the server stays the authority with its Bahasa 400.

Pinned twice: at the unit level (`getMaxPostImages()` stays 5 across four failure
shapes) and at the composer level ("falls back to a default limit when GET /users/limits
fails, and stays usable", which then attaches a photo and sends the post).

## What happens to typed text when an upload fails

Nothing. The failure is written to **one row of `images`**, by `key`, through a
functional `setImages`. `body` is not touched, no other image is touched, and the
composer renders the failed row with its own Bahasa sentence (`"Foto gagal diunggah."` +
`describeRequestFailure(err)`) and a "Coba lagi" that re-sends the same `File`. Kirim
stays available: a photo that will not upload must not hold a written post hostage, and
only the ids that actually landed are sent. This is asserted directly — the test types
`"naskah yang panjang"`, fails the upload, and then asserts the textarea still reads
`"naskah yang panjang"`.

A failed *send* (the POST/PATCH itself) keeps both the text and the photos, for the same
reason: making somebody re-pick and re-upload every photo to retry a post they already
wrote would be the worst outcome available here.

## Test counts

| | before | after |
|---|---|---|
| web suite | 654 pass / 0 fail, 44 files | **716 pass / 0 fail, 45 files** |
| `apps/web` typecheck | clean | clean |

New: `MediaStrip.test.tsx` (18), `PostComposer.test.tsx` +30, `apiClient.test.ts` +17,
`BerandaPage.test.tsx` +2 (wiring), `App.test.tsx` +1 (boot fetch).

---

## Judgement calls the thin brief left open

1. **The limit is fetched once at App boot into a module store, not per composer mount.**
   The obvious alternative (a `useEffect` in `PostComposer`) issues a `GET /users/limits`
   from inside every signed-in page render, and React runs child effects first — so it
   would land as `calls[0]` and break roughly a dozen existing `calls.length` /
   `calls[0].url` assertions in `BerandaPage.test.tsx` and `ProfilePage.test.tsx`, tests
   this task has no business rewriting. A boot-time load also matches §6's own wording
   ("the app fetches it once at boot") and costs one request per page load rather than one
   per composer mount. The composer subscribes via `useSyncExternalStore`, so a composer
   already on screen when the answer lands picks it up.
2. **`resetPostImageLimitForTesting` is exported.** Module state is a singleton for the
   life of a test file, so without it one test's limit decides the next test's composer.
   This is an existing idiom here — `dashboard/paymentAccount.ts` exports the same thing
   for the same reason — not a new one.
3. **`PostView.media` is REQUIRED.** The API guarantees the key is always present, and
   mirroring that lets the edit composer write `post.media` rather than `post.media ?? []`
   over a field the server always sends. Cost: five fixtures gained `media: []`.
4. **A failed image does not block Kirim; only `ready` ids are sent.** §7 pins "disabled
   while an upload is in flight" and says nothing about failures. Blocking would trap
   somebody whose photo will not upload; the failure is on screen with a retry and a
   remove beside it, so sending without it is a visible choice, not a silent loss.
5. **Uploading and failed images both count against the limit.** They occupy slots the
   person can see. Counting only finished ones would let five uploads in flight become a
   sixth attachment the server refuses.
6. **A multi-pick beyond the remaining room is clamped silently.** The picker is
   `multiple`, so somebody at four of five can select three. Taking all of them builds a
   request refused in full; taking two and showing `5/5 foto` with "Tambah foto" disabled
   says what happened without a modal. (An explicit "only N were added" notice was the
   alternative; I judged the counter enough, and it is the same signal the button gives.)
7. **Progress is indeterminate ("Mengunggah…", `role="progressbar"` with no value).**
   `fetch` reports no upload progress; a percentage would have to be invented, and
   rewriting the upload on `XMLHttpRequest` just to obtain one is not worth reintroducing
   a second request path with its own auth handling. The honest fact — "this one is still
   going, which is why Kirim is disabled" — is what is shown.
8. **`MediaStrip` is presentational; `PostComposer` owns uploads.** This keeps `canSubmit`
   — the §7.1 rule — inside the component that owns the submit button. The strip cannot
   accidentally enable anything.
9. **The composer always passes an array to `onSubmit` (`[]` when empty), while
   `createPost`/`editPost` OMIT the key when the argument is `undefined`.** The
   distinction lives where it is real (spec §5.2's PATCH semantics), and the composer,
   which always knows the complete desired list, always states it.
10. **Bahasa copy chosen here** (none of it was specified beyond "Tambah foto"):
    `"Mengunggah…"`, `"Foto gagal diunggah."` (deliberately NOT `SUBMIT_FAILED_PREFIX`'s
    "Kiriman gagal disimpan" — nothing has been sent yet), `"Coba lagi"` with the
    accessible name `"Coba lagi unggah foto N"`, `"Hapus foto N"`, `"Pratinjau foto N"`,
    and the counter `"N/M foto"`. Positions are 1-based in every name, because they are
    read aloud and printed in test failures.
11. **Wiring beyond the three briefed files.** `onSubmit` gaining a second parameter
    forces `BerandaPage.tsx` and `postOwnerActions.tsx` to change, and without `App.tsx`
    nothing would ever fetch the limit. Two integration tests in `BerandaPage.test.tsx`
    pin that the ids actually reach `createPost`/`editPost` — without them, dropping the
    second argument would leave the whole media suite green while no photo reached a post.
12. **Two `App.test.tsx` assertions now filter by URL** (`calls.filter(url => url ===
    "/users/me")`) instead of counting all fetches. Both tests are named "triggers … a
    /users/me request", so this matches their stated intent and is stricter than a bare
    count; a third test pins the new boot fetch.
13. **Object URLs are revoked** on removal, after a successful send, and on unmount. This
    is where self-review found a bug of my own (see below).

## Self-review

Read the whole diff with fresh eyes after committing. Two things came out of it, both
fixed in `a5ca4ad`:

- **A real leak.** The unmount cleanup captured `objectUrls.current` at MOUNT time, while
  `releasePreview` REPLACES that array with a filtered copy. Every preview created after
  the first removal therefore lived in an array the cleanup had never seen. Reproduced
  with attach → remove → attach → leave, which went red, then fixed by reading the ref at
  cleanup time (the ref object is stable; the array is not).
- An `as File` cast in `attachFiles` replaced by a real null check, and one over-long
  import line wrapped to match the file.

`git status` is clean; `bun test` 716/0 and `bun run typecheck` clean at `a5ca4ad`.

## Not done here (by design)

- **`PostCard` still renders no images** — that is Task 9. The `media` field it needs is
  on `PostView` and populated; the edit test in `BerandaPage.test.tsx` deliberately
  queries the strip by its own alt text (`/^Pratinjau foto/`) so it keeps meaning the
  strip once cards render images too.
- **No drag-to-reorder** (spec §5.2 defers it to a later phase).

---

# Fix round 1 (review of Task 8)

**Commits:** `ff544b1` (the five fixes), `f5f4dc8` (one extra test, mutation-driven).
Web suite **716 → 736** pass / 0 fail, `bun run typecheck` clean, `git status` clean.

## 1. (Important) Every upload failure showed the same unactionable sentence

Closed from **both** ends, because the two failures an Indonesian phone actually
produces are both plain 400s and neither can be fixed by retrying.

**a. The size case never leaves the phone.** `apiClient.ts` now exports
`MAX_UPLOAD_BYTES = 10 * 1024 * 1024` — the same value as
`apps/api/src/domain/image.ts`, copied rather than shared for the reason this file's
module docstring already gives (the web is a static build with no access to the API's
modules). Unlike the image LIMIT, this one is not env-driven on either side, so the two
can only drift by somebody editing one and not the other; the docstring says so, and
says the server remains the authority (`UploadMedia` still checks byte length before
sharp sees anything). `PostComposer.attachFiles` filters oversized files out **before
any request** — the test asserts `calls.length === 0`, so not one byte of a 12 MB photo
is spent to be told no on a phone connection.

**b. The format case gets a sentence that says what to do.** New
`describeUploadFailure` in `errorCopy.ts`:

> **400** → `"Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung."`
> **everything else** → delegated to `describeRequestFailure` unchanged (401, 404, 413,
> 429, 5xx, dropped connection — for those "coba lagi" really is the right advice).

Rendered as `"Foto gagal diunggah. Format ini tidak didukung. …"`.

**Why this does not break the no-raw-server-errors rule.** The sentence is chosen by the
SHAPE of the failure — status 400 from `POST /users/media` — and authored in
`errorCopy.ts`. Nothing reads `err.message`; `src/test/no-raw-server-errors.test.ts` is
green. The reasoning that makes the shape sufficient is recorded in the function's own
docstring: that route's only other 400s are a missing file (`uploadMedia` always sends
one) and the size limit (now refused locally against the same constant), so what remains
is bytes that are not a supported image. A test asserts the API's own Bahasa sentence
(`"Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."`) does **not** appear on
screen — this is the easiest place in the codebase to justify printing `err.message`,
since the wire's text is already Bahasa, and the rule is not "English is banned" but
"a screen never prints what the wire sent".

**Copy chosen (all Bahasa, all asserted as literals):**

| situation | sentence |
|---|---|
| file over the limit | `1 foto tidak ditambahkan — ukuran foto maksimal 10 MB.` |
| pick past the image limit | `3 foto tidak ditambahkan — maksimal 5 foto per kiriman.` |
| both in one pick | the two sentences, joined by a space |
| unsupported format (400) | `Foto gagal diunggah. Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung.` |

Counts are photos, not rules, because the count is the part ambient state cannot convey.
Indonesian does not inflect for plural, so one sentence shape serves any count. `10` is
derived from `MAX_UPLOAD_BYTES` so the copy cannot drift from the constant, and the tests
assert the literal `10 MB`.

## 2. (Important) The silent multi-pick clamp

The clamp stays; it is now **stated**. `MediaStrip` gained a `notice: string | null` prop
rendered as a `role="alert"` paragraph directly below "Tambah foto" — the button that
produced the event — separate from the per-image alerts (a test asserts both can be on
screen at once and reads them apart). `PostComposer` holds the one `useState<string |
null>`, recomputed by every pick and cleared by anything that makes it stale:

- a clean pick clears it (nothing was dropped this time),
- a removal clears it (there is room again, so the old count misdescribes what can be
  added now),
- a successful send clears it with the rest of the strip.

## 3. (Minor) The two `App.test.tsx` assertions

Restored to the reviewer's stricter form, verbatim: `expect([...calls].sort()).toEqual(["/users/limits", "/users/me"])`
and `expect(calls).toEqual(["/users/limits"])`. Ran the file three times: 27/0 each, no
flake, as predicted — both requests are issued synchronously by the one boot effect.
String arrays, so they stay inside the DOM-hazard rule.

## 4. (Minor) `busy={submitting}` pinned

Two tests: the strip freezes while the send is in flight (add and remove disabled) and
frees again afterwards, and a failed image's "Coba lagi" is frozen too.

## 5. (Minor) Stray trailing blank line in `apiClient.ts` — removed.

## Mutation evidence for the new pins

Applied to the committed tree, run, reverted:

| mutation | result |
|---|---|
| `describeUploadFailure`'s 400 branch disabled (back to the generic sentence) | 2 fail |
| the local `file.size` filter removed | 3 fail |
| the clamp sentence never pushed | 4 fail |
| the notice element removed from `MediaStrip` | 8 fail |
| the notice never cleared on a removal | 1 fail |
| `busy={submitting}` → `busy={false}` | 2 fail |
| an extra `fetch` added to `App`'s boot effect | 3 fail |
| **the notice never cleared on a clean PICK** | **0 fail — SURVIVED** |

The survivor was a gap in my test, not in the fix: the test covering a stale notice
removed a photo first, and removal clears the notice on its own, so the pick path was
never exercised alone. `f5f4dc8` adds a test that picks twice with nothing removed in
between — the oversized file was never added, so only the pick can clear — and that
mutation now fails 1 test.

## DOM-hazard rule

Unchanged and observed throughout, including in the mutation runs: every new assertion is
a string, an array of strings, a count or a boolean. The notice tests read `textContent`;
`notices()` maps alerts to their text before any comparison.

## Test counts

| | before round 1 | after |
|---|---|---|
| web suite | 716 pass / 0 fail | **736 pass / 0 fail** (45 files) |

New: `errorCopy.test.ts` +7, `MediaStrip.test.tsx` +3, `PostComposer.test.tsx` +10,
`App.test.tsx` assertions strengthened (no count change).

Untouched, as instructed: M3 (the limit store in `App.test.tsx`), M4 (unmount with
uploads in flight), M5 (a failed image holding a slot), M6 (the `vite.config.ts`
comment).

`git status` is clean at `f5f4dc8`.
