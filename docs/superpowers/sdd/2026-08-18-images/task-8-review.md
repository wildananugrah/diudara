# Task 8 review — the web client and the composer's media strip

**Range:** `d7038a9..a5ca4ad` (3 commits, 2,073 insertions, 15 files).
**Reviewed against:** spec §6, §7, §7.1 (`docs/superpowers/specs/2026-08-18-images-design.md`),
the binding authority, since `task-8-brief.md` is deliberately thin.

## Verdicts

**1. Spec compliance: ✅** — every clause of §6, §7 and §7.1 is implemented and, with one
exception noted below, pinned by a test that dies when the behaviour is mutated away.

**2. Task quality: approved with findings** — 2 Important, 5 Minor. Nothing Critical. Nothing
here blocks the branch; I1 and I2 are product decisions worth taking before Phase 4 ships.

---

## What I verified, and how

Baseline `bun test` in `apps/web`: **716 pass / 0 fail, 45 files, ~18 s**. `bun run typecheck`
clean. Every mutation below was applied to the committed tree, run, and reverted with
`git checkout --`. `git status` is clean at `a5ca4ad`.

### The §7.1 trap — the owner's explicit rule

| mutation | result |
|---|---|
| `canSubmit` widened to `(trimmed.length > 0 \|\| images.length > 0)` | **2 fail, 37 ms** — `an attached photo NEVER enables Kirim on its own`, `still refuses a whitespace-only caption with a photo attached` |

`canSubmit` is `trimmed.length > 0 && !overLimit && !submitting && !uploading`. Images appear in
it only through `uploading`, which can only NARROW it. The rule is enforced in `PostComposer`,
the component that owns the submit button; `MediaStrip` is purely presentational and holds no
state, so it has nothing to widen it with. This is the right structural answer to §7.1, not just
the right expression.

The killing test is also honest: it waits for the upload to *land* before asserting Kirim is
still disabled, so it is not a disabled button for want of an upload.

### The rest of §7

| mutation | result |
|---|---|
| `&& !uploading` removed from `canSubmit` | 1 fail — `Kirim is disabled while an upload is still in flight` |
| `setBody("")` added to `runUpload`'s catch (destroy the caption on a failed upload) | 2 fail — `a failed upload marks that image, keeps the text, and offers a retry` |
| `removeImage` refuses rows with no local `File` (seeded images not removable) | 4 fail, incl. `each seeded image is removable, and Simpan sends the list that is left` |
| `initialMedia={post.media}` dropped from `EditComposer` | 1 fail — `BerandaPage … an edit sends the post's images back as the COMPLETE list, minus the one removed` |
| `key={post.id}` dropped from `EditComposer` | 3 fail |
| multi-pick clamp `files.slice(0, room)` → `files` | 1 fail — `attaches only as many of a multi-pick as there is room for` |
| `authorizedHeaders`' `FormData` guard removed | 1 fail — `sends the Bearer token but NO Content-Type` |

The caption-preservation test is the one the brief cares most about and it is explicit: it types
`"naskah yang panjang"`, fails the upload with a 500, and asserts the textarea still reads
`"naskah yang panjang"`. A failed *send* is pinned separately (`KEEPS the attached photos when the
send itself fails`) and keeps both text and photos.

Batal is proved the way a page actually does it — an `EditHost` harness unmounts and re-opens the
composer — and covers both directions: an image ADDED during the edit is discarded, and a REMOVAL
made during the edit is discarded too.

### §6's fallback — genuinely tested, not merely implemented

| mutation | result |
|---|---|
| `loadPostImageLimit` rethrows instead of swallowing | 4 fail, incl. `falls back to a default limit when GET /users/limits fails, and stays usable` |
| the `Number.isInteger(value) && value >= 1` shape check removed | 1 fail — `keeps the built-in 5 when the answer is not a whole number of at least 1` |

The composer-level test does the whole thing §6 asks for: it makes `GET /users/limits` answer a
500, then asserts the composer **opens** (`0/5 foto`, "Tambah foto" enabled), attaches a photo,
and **sends** the post with its id. That is the product claim, not just the unit behaviour.

The shape check deserves separate credit. Adopting a `0`, a `"5"` or a `NaN` as the cap would
disable "Tambah foto" for ever — the exact failure §6 forbids, reached through the success path
rather than the error path. It is checked and pinned.

### Object-URL leaks

The self-reviewed fix is real. The unmount cleanup now reads `objectUrls.current` at cleanup time,
and `releasePreview` replaces the array rather than mutating it — so the bug (previews created
after a removal living in an array the cleanup never saw) is genuinely closed. It is pinned by
`frees a preview created AFTER an earlier one was removed`, whose sequence (attach → remove →
attach → unmount) is the shortest one that reaches it.

I checked the path the report did **not** mention — **unmount with uploads still in flight** — by
writing a throwaway test (two files chosen, `fetch` left hanging, `unmount()` while both
progressbars are on screen, then deleted). Both object URLs are revoked. `previewFor` pushes to
the ref the instant a file is chosen, before the upload resolves, so an in-flight preview is
always in the array the cleanup reads. No leak, but no test either — see M4.

### Hazard discipline

**No DOM node reaches any assertion that can fail.** The new tests assert on
`getAttribute("src")` string arrays, `queryAllByRole(...).length` counts, `.disabled` booleans,
`.textContent` strings, and — for "which image did the callback mean?" — the row's `key` string
(`expect(retried).toEqual(["k2"])`). That last choice is better than `isNode` here, not a
substitute for it: it asserts identity as data rather than as a reference.

`src/test/no-hanging-dom-assertions.test.ts` is green. Every mutation I ran failed in
**0.2–60 ms**; nothing hung, nothing serialised.

One letter-of-the-law nit: `expect(screen.getByRole("button", { name: "Coba lagi unggah foto 2" })).toBeTruthy()`
(PostComposer.test.tsx:676) does put an element on the left of a matcher. It cannot actually fail
with a node on board — `getByRole` throws on absence, so `toBeTruthy` never receives a falsy
element — so this is not a live hazard, and the guard's matcher list correctly does not flag it.
Mentioned only so it is not read as an oversight later.

### The error-copy rule

`src/test/no-raw-server-errors.test.ts` is green. No new file reads `.message` off a caught value.
`MediaStrip` receives `error` as a **finished Bahasa sentence**, built by `PostComposer` as
`` `${UPLOAD_FAILED_PREFIX} ${describeRequestFailure(err)}` `` — chosen by the failure's SHAPE.
Pinned directly by `never shows the server's own error text on a failed upload`, which feeds back
`"unsupported image format"` on a 400 and asserts it appears nowhere on screen.

Separating `UPLOAD_FAILED_PREFIX` ("Foto gagal diunggah.") from `SUBMIT_FAILED_PREFIX` ("Kiriman
gagal disimpan.") is right: nothing has been sent when an upload fails, and saying otherwise
would be a lie.

### Bahasa Indonesia

All new user-facing copy is Bahasa: `Tambah foto`, `Mengunggah…`, `Foto gagal diunggah.`,
`Coba lagi`, `Coba lagi unggah foto N`, `Hapus foto N`, `Pratinjau foto N`, `Pilih foto`,
`Foto kiriman`, `N/M foto`, and `gagal memuat batas kiriman`. Positions are 1-based, which is
right for names that get read aloud.

### Literals, never constants

`MAX_POST_BODY_LENGTH`, `MAX_POST_IMAGES` and `FALLBACK_MAX_POST_IMAGES` appear in the new tests
only inside comments. Every assertion uses `1000`, `1001`, `5`, `2`, `3` as literals. Correct.

### `PostView.media` required

Consistent with the API. Every post-shaped response is built through `toPostView`
(`apps/api/src/application/use-cases/post-views.ts`), which takes `media` as a parameter rather
than defaulting it — `write-post.ts` passes `[]` or the real list on both create and edit, and
`toFeedPage` passes `byPost.get(row.id) ?? []`. There is no path on which the API omits the key.
The five fixtures gaining `media: []` are stating a real guarantee, and it is what lets
`EditComposer` write `post.media` instead of `post.media ?? []`.

---

## Judgement on the three numbered questions

### 1. The two reworded `App.test.tsx` assertions — a real, small weakening; fixable in two lines

The direction is defensible and the new third test (`asks GET /users/limits once at boot, session
or no session`) is a genuine addition. But the rewrite dropped more than it had to:

- Test 1 lost **both** `expect(calls.length).toBe(1)` **and** `expect(calls[0]).toBe("/users/me")`.
  It no longer constrains total traffic or ordering.
- Test 2's `expect(calls.length).toBe(0)` — "this page load makes **no** requests at all" — became
  "makes no `/users/me` requests". That is the bigger loss of the two: it was the assertion that
  would catch any future boot-time fetch nobody meant to add.

The stricter form keeps both guarantees, and I confirmed it works. I applied it to the tree and ran
`src/App.test.tsx` three times: **27 pass / 0 fail** each time, no flake. Both fetches are issued
synchronously inside the same boot effect, so the total is deterministic by the time `waitFor`
resolves.

```ts
// test 1, after the existing waitFor:
expect([...calls].sort()).toEqual(["/users/limits", "/users/me"]);

// test 2, replacing the filtered form:
expect(calls).toEqual(["/users/limits"]);
```

Both are string arrays, so they stay inside the DOM-node hazard rule. **Verdict: an acceptable
trade only because it is trivially improvable — take the stricter form (M1).**

### 2. The four disclosed judgement calls

**(a) A failed image does not block Kirim — agree.** §7 pins "disabled while an upload is in
flight" and is silent on failures. The two are genuinely different: an in-flight upload will
produce an id the post must not reference *yet*, whereas a failed one never will. Blocking would
hold a written caption hostage to a photo that may never upload. The failure is on screen with a
retry and a remove beside it, and `attachedIds` sends only `ready` rows, so sending without it is a
visible choice. Pinned by `does not block Kirim, and sends only the photos that landed`.

**(b) Uploading and failed images count against the limit — agree for uploading, mild friction for
failed.** An in-flight upload occupies a slot whose id is going onto the post; counting only
finished ones would let five uploads in flight become a sixth attachment the server refuses. That
part is clearly right. Counting *failed* rows is more debatable — a failed row contributes no id,
so somebody at 5/5 with two failures must remove them before adding replacements. But the
alternative makes the counter lie about rows the person can see, and "remove the failure, then add
another" is one visible tap. Right call; recorded as M5 only so the friction is on the record.

**(c) The silent clamp on a multi-pick — I agree with you. This is the weakest decision in the
task.** Recorded as **I2**, Important. Picking eight photos and having three disappear with no word
is an *event* being reported through *ambient state*. "5/5 foto" and a disabled button describe the
strip's condition; they do not say "three of the photos you just chose were not taken", and they
cannot say **which** three. On a 390px phone the person would have to count thumbnails against what
they remember selecting. The report's own defence — "it is the same signal the button gives" —
concedes the point: the button's signal is *you cannot add more*, which is a different sentence
from *I dropped some of what you just gave me*.

The clamp itself is correct and must stay (building a request the server refuses in full would be
worse). What is missing is one sentence. This costs a `useState<string | null>` and a Bahasa line
in the strip's existing alert region — e.g. `"Hanya 2 foto yang ditambahkan. Batas 5 foto per
kiriman."` — and it is the same discipline the rest of this composer already follows: every other
thing that happens to somebody's content here (an upload failing, a send failing) gets a sentence.

**(d) Indeterminate progress — agree, and the reasoning is the right shape.** `fetch` genuinely
reports no upload progress; a percentage would be invented. Rewriting `uploadMedia` on
`XMLHttpRequest` would reintroduce a second request path with its own 401 handling, outside
`apiFetch` — which is the one place that clears a dead session. That is a real architectural cost
for a cosmetic gain. `role="progressbar"` with no `aria-valuenow` is the correct ARIA encoding for
an indeterminate task, and "Mengunggah…" is the fact that matters while Kirim is disabled.

### 3. The module store — cannot leak, and the reset is load-bearing

Confirmed by mutation, and the leak is **real, not theoretical**. With
`resetPostImageLimitForTesting` mutated to a no-op:

- `bun test` (whole suite): **6 fail**
- `bun test src/user/apiClient.test.ts` alone: **3 fail**
- `bun test src/user/PostComposer.test.tsx src/user/apiClient.test.ts`: **6 fail**, including
  `starts at the built-in default of 5 before anything is fetched` — which passes when
  `apiClient.test.ts` runs alone and fails when `PostComposer.test.tsx` runs first.

That last pair is the proof: bun shares the module registry across test files in a process, so the
limit genuinely crosses file boundaries, and the reset is the only thing stopping it. It is called
in `PostComposer.test.tsx`'s global `afterEach` and in `apiClient.test.ts`'s
`describe("… the advisory image limit …")` `afterEach`. Both files clean up after themselves, so
neither can poison a file that runs later.

Mirroring `dashboard/paymentAccount.ts`'s `resetPaymentAccountCacheForTesting` is the right call —
this is an existing idiom in this codebase, not a new one invented for this task.

The rationale for boot-time-store-over-per-composer-fetch also holds up: React runs child effects
before parent effects, so a `useEffect` in `PostComposer` would land as `calls[0]` and break the
`calls[0].url` assertions in `BerandaPage.test.tsx` and `ProfilePage.test.tsx`. And it matches §6's
own wording — "the app fetches it once at boot". `useSyncExternalStore` means a composer already on
screen when the answer lands picks it up, which is pinned by `notifies subscribers when the number
changes`.

One gap: **`App.test.tsx` never resets the store** (M3 below).

---

## Findings

### Important

**I1 — every upload failure says the same unactionable sentence, including the two that will
actually happen.**
`describeRequestFailure` collapses every 4xx to `"Permintaan tidak dapat diproses. Coba lagi."`, so
a failed upload reads `"Foto gagal diunggah. Permintaan tidak dapat diproses. Coba lagi."` and
offers a "Coba lagi" that will fail identically, for ever. The API's two real refusals are both
plain 400s: `Ukuran foto maksimal 10 MB.` (`apps/api/src/application/use-cases/upload-media.ts`,
`MAX_UPLOAD_BYTES = 10 * 1024 * 1024`) and `UnsupportedImageError` for a format outside `ACCEPTED`
(`apps/api/src/domain/image.ts`). On a phone-first product both are likely: a modern phone photo
can exceed 10 MB, and HEIC is the iPhone default while `accept="image/*"` happily passes it.

The `no-raw-server-errors` rule correctly forbids rendering the server's string — but it does not
forbid a **client-authored** sentence chosen by shape. A 400 on `POST /users/media` is a shape with
exactly two causes, so the composer can say something true and actionable without ever reading the
server's text, e.g. `"Foto gagal diunggah. Pastikan berkasnya berupa gambar (JPEG, PNG atau WebP)
dan tidak lebih dari 10 MB."` Better still, check `file.size` before uploading and refuse locally,
so the person never spends a slow mobile upload to be told no.

Not a spec violation — §7 only requires that a failure marks its image, leaves the text alone and
offers a retry, and all three hold. Flagged because an infinite retry on an unfixable cause is the
kind of thing that reaches a real user before it reaches a reviewer.

**I2 — a multi-pick over the limit is clamped with no word to the person.** See question 2(c)
above. The clamp is right; the silence is not. One `useState<string | null>` and one Bahasa
sentence in the strip's existing `role="alert"` region.

### Minor

**M1 — the two reworded `App.test.tsx` assertions lost the "no other traffic" guarantee.** See
question 1. Two lines restore it; verified passing three times with no flake.

**M2 — `busy={submitting}` is not pinned at the composer level.** Mutating `busy={submitting}` to
`busy={false}` in `PostComposer.tsx` leaves the whole suite at **716/0**. `MediaStrip.test.tsx`
proves `busy: true` disables adding, removing and retrying, but nothing proves the composer ever
passes `true`. The blast radius is small — `attachedIds` is captured at `onSubmit` call time, so a
mid-flight change cannot alter what was sent — but a photo added during the flight would then
survive the success path's `for (const image of images) releasePreview(image)` (a stale closure)
while `setImages([])` drops its row, leaking that object URL until unmount. One assertion in the
existing `disables the button while a submit is in flight` test closes it: while the send is in
flight, assert `addButton().disabled` is `true`.

**M3 — `App.test.tsx` renders `<App />` (which calls `loadPostImageLimit`) but never calls
`resetPostImageLimitForTesting`.** Harmless today: its mocks return either a user object or
`{ maxPostImages: 5 }`, and the shape check rejects everything that is not a whole number ≥ 1, so
the stored value never moves off 5. It is a latent trap — the next person who writes an `App` test
mocking `{ maxPostImages: 3 }` poisons every file that runs after it, and M8's evidence above shows
that leakage is real. A one-line `afterEach` in that file removes the trap.

**M4 — unmount-with-uploads-in-flight is correct but untested.** I verified it holds (throwaway
test, both previews revoked, since `previewFor` pushes to the ref before the upload resolves). The
existing leak tests all settle their uploads first. Adding `unmount()` while a `fetch` is left
hanging would pin the one revocation path nothing currently covers.

**M5 — a failed image occupies a slot until it is removed.** See question 2(b). Deliberate and
defensible; recorded so the friction is a decision rather than a discovery.

**M6 — `vite.config.ts`'s `^/users/` entry states an invariant that is now stale.** Its comment
says "every one of these paths is reached only by `fetch()` … never by a browser navigation", but
`mediaThumbUrl` now feeds `<img src="/users/media/:id/thumb">` — a subresource, not a `fetch`.
Harmless in fact (that entry has no `bypass`, and an `<img>` request does not send
`Accept: text/html` anyway), and the proxy works. But `src/test/vite-proxy-coverage.test.ts` only
greps the `fetch`-family call sites, so this new class of network use is invisible to the guard
that exists precisely because a missing proxy entry has broken this project three times. Worth a
sentence in the comment before Task 9 renders images on cards.

**M7 — a stray trailing blank line at the end of `apps/web/src/user/apiClient.ts`.** Cosmetic;
there is no linter to catch it.

---

## Mutation log (all reverted; tree clean)

| # | mutation | fails | verdict |
|---|---|---|---|
| 1 | `canSubmit` widened to text-OR-image (**§7.1 trap**) | 2 | killed, 37 ms |
| 2 | `&& !uploading` removed | 1 | killed |
| 3 | `setBody("")` in the upload catch (destroy the caption) | 2 | killed |
| 4 | `loadPostImageLimit` rethrows | 4 | killed |
| 5 | limit shape check removed | 1 | killed |
| 6 | `initialMedia` dropped from `EditComposer` | 1 | killed |
| 7 | `key={post.id}` dropped from `EditComposer` | 3 | killed |
| 8 | seeded images made non-removable | 4 | killed |
| 9 | multi-pick clamp removed | 1 | killed |
| 10 | `attachedIds` ignores `status` | 0 | **equivalent mutant** — `mediaId` is non-null only while `status === "ready"`, and a `ready` row is unreachable from the retry button. Not a test gap. |
| 11 | `FormData` guard removed from `authorizedHeaders` | 1 | killed |
| 12 | `busy={submitting}` → `busy={false}` | 0 | **survived → M2** |
| 13 | `resetPostImageLimitForTesting` made a no-op | 6 | killed; also proves cross-file leakage is real |
| — | stricter `App.test.tsx` totals (experiment, not a mutation) | 0 × 3 runs | the stricter form is available → M1 |

## Final state

`git status` clean at `a5ca4ad`. `bun test` in `apps/web`: **716 pass / 0 fail, 45 files,
19.02 s**. `bun run typecheck` clean. The throwaway leak test was deleted.
