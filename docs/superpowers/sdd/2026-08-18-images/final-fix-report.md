# Phase 4 (images) — final whole-branch review, fix wave

Branch `feat/images`, from `ba15500`. Four commits:

| SHA | What |
|---|---|
| `65a9b21` | C1 + C2 — the feed's image layout, measured in a browser |
| `c9cb71b` | I1 + I2 (client) + I3 + the error code + `MAX_UPLOAD_BYTES` into `packages/shared` |
| `2d6ca4d` | I4 — the sweep can no longer delete a post's live media |
| `8986416` | I2 (server) nginx, the `deploy.sh` reorder, and the minors |

**Suites, final run:** api **2165 / 0** (238 s), web **750 / 0** (18 s), worker **52 / 0**,
shared **85 / 0**. `apps/web/src/test/` (the three guard files, including
`no-raw-server-errors` and `no-hanging-dom-assertions`) **12 / 0**. All four workspaces
`tsc --noEmit` clean. `git status --short` empty.

Baselines were api 2148, web 745, worker 50, shared 82 — so +17 / +5 / +2 / +3 tests, no
deletions except the two unfalsifiable lines M7 names.

---

## C1 / C2 — the feed's image layout. MEASURED, not reasoned about.

`apps/web/src/styles.css`. happy-dom computes no layout, so this was driven in headless
Chrome (`~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`, `--dump-dom`, no
debugging port, no server, a local `file://` page) against **this branch's own stylesheet**
and `PostCard`'s own markup — `<img width={1200} height={1600}>` in a
`.post-card-media[data-count=N]` — at container widths 390 px and 1440 px, both before the
bytes load and after. Harness under the session scratchpad.

### Before (HEAD `ba15500`)

| count | 390 px, before load | 390 px, after load | 1440 px, after load |
|---|---|---|---|
| 1 | container 390×**1600** | 390×**1600** | 1440×**1600** |
| 2 | 390×**1600**, tiles **1600×1600** | tiles 193×**1600** | tiles 718×**1600** |
| 3 | 390×**3204** | 390×**3204** | 1440×**3204** |
| 4 | 390×**3204** | 390×**3204** | 1440×**3204** |
| 5 | 390×**3204** | 390×**3204** | 1440×**3204** |

Every box as tall as the stored full image. A five-image post occupied **3,204 px** of a
390 px phone screen. Before load the two/three/four-image tiles measured **1600×1600** —
a grid item's `min-width: auto` resolving to the replaced element's intrinsic width —
overflowing their 193 px column (hidden only by the container's `overflow: hidden`).

### `height: auto` alone — the fix that looks obvious and is wrong

| count | 390 px, before load | 390 px, after load |
|---|---|---|
| 1 | **390×20** | 390×520 |
| 2 | 193×193 | 193×193 |
| 3 | 390×390 | 390×390 |
| 5 | 390×324 | 390×324 |

`[data-count="1"] img { aspect-ratio: auto }` discards the ratio the UA derives from the
`width`/`height` attributes, so the **most common post shape reserves nothing** (20 px is
the broken-image placeholder) and reflows to 520 the instant the byte lands — exactly what
`post_media.width`/`.height` exist to prevent (spec §4).

### After (shipped)

```css
.post-card-media img { display: block; width: 100%; height: auto; object-fit: cover; background: var(--line); }
.post-card-media:not([data-count="1"]) img { aspect-ratio: 1 / 1; }
```

| count | 390 px, before load | 390 px, after load | 1440 px, after load |
|---|---|---|---|
| 1 | 390×520 | 390×520 | 1440×1920 |
| 2 | tiles 193×193 | tiles 193×193 | tiles 718×718 |
| 3 | 390×390 | 390×390 | 1440×1440 |
| 4 | 390×390 | 390×390 | 1440×1440 |
| 5 | 390×324 | 390×324 | 1440×1199 |

**Container geometry is identical before and after load at every count — nothing reflows.**
390 × 1600/1200 = 520, so the single-image case is the stored ratio exactly.

One residual, honestly: at `count=3` before load, the row-spanning first tile measures
390×390 rather than its final 193×390 — the *container* is 390×390 either way, so the card
does not move; only the tile inside it settles. Tested `min-width: 0` on the item and it
changes the shape of the discrepancy without removing it, so the review's prescribed rule
shipped unchanged.

**Nothing in the suite can catch a regression here.** The gate checklist's step 6 now says
what to look at, in numbers: a single portrait photo is about 3:4 of the card's width, not a
square and not a full-screen column.

---

## I1 — the pixel bomb. Measured on real bytes.

`apps/api/src/domain/image.ts`, `packages/shared/src/media.schema.ts`.

`MAX_UPLOAD_BYTES` bounds the wire, not the bitmap, and nothing passed `limitInputPixels`,
so sharp's default 268 MP ceiling applied. Measured on this machine, `/usr/bin/time -v`,
against **HEAD's `processUpload` verbatim** (extracted with `git show`):

| input | wire | peak RSS | wall | outcome |
|---|---|---|---|---|
| 9000×5000 PNG (45 MP) | **5.5 KB** | 229 MB | 2.5 s | accepted |
| 8000×8000 PNG (64 MP) | 187 KB | 230 MB | 2.8 s | accepted |
| 12000×12000 PNG (144 MP) | 421 KB | 253 MB | 3.7 s | accepted |
| 12000×12000 **interlaced** PNG | 421 KB | **655 MB** | 8.5 s | accepted |
| 16000×16000 **interlaced** PNG (256 MP) | **748 KB** | **998 MB** | 13.5 s | accepted |

Note the interlaced rows: libvips decodes a sequential PNG in a streaming pass, so a plain
solid-colour bomb costs "only" ~250 MB, but a **progressive/interlaced** PNG forces a
whole-image buffer and takes the same file to 655 MB and 998 MB. That is the shape an
attacker would send, and it reproduces the review's 750 MB / 1.4 GB magnitude. My headline
figure is therefore **998 MB and 13.5 s of CPU from a 748 KB upload**, repeatable, against a
single-process API with open signup.

After the bound, the same three files:

| input | peak RSS | wall | outcome |
|---|---|---|---|
| 9000×5000 (the committed fixture) | **70 MB** | 0.16 s | refused |
| 12000×12000 interlaced | **69 MB** | 0.15 s | refused |
| a real 1200×1600 phone photo (control) | 88 MB | 0.46 s | accepted |

70 MB is the bun+sharp process floor; the refusal costs the file's own bytes and nothing
more, because it happens on the `metadata()` header read that already ran, before any
`.toBuffer()`.

**The bound is 40 MP** (`MAX_UPLOAD_PIXELS`). Comfortably above every real camera whose
output this route accepts — a 12 MP phone photo is 0.3× it, a 48 MP sensor's
full-resolution JPEG 0.8× — and it caps the worst *accepted* decode at roughly 400 MB rather
than 2.6 GB. `limitInputPixels` is also passed to both `sharp()` constructors over untrusted
bytes as a second layer, documented as belt-and-braces rather than as the bound.

Pinned with **a real fixture**, `apps/api/src/test-support/fixtures/oversized-dimensions.png`
— 5,584 bytes, 9000×5000, 45 MP. The test asserts the file is under 64 KB, which is the
whole point of the attack. Driven through the route as well as the domain.

Mutation-tested: deleting the bound reddens 4 tests across `image.test.ts` and
`media.test.ts`.

---

## I2 — nginx's `client_max_body_size`.

### What I found, plainly: **the production nginx config is not in this repository.**

Grepped `infra/`, `scripts/`, `docs/`, `CONTRIBUTING.md`: zero occurrences of
`client_max_body_size` anywhere. The only nginx artifact is
`infra/nginx/live-hls.conf.template`, and its own header says what it is — a **fragment**,
four `location` blocks (`/live/`, `/whip/`, the internal auth subrequest, and the
`deny all` on `/webhooks/mediamtx/`) meant to be pasted into a server block that exists only
on the VPS. `scripts/deploy.sh` states in its header that it does not touch nginx.
CONTRIBUTING.md's nginx section is entirely about the streaming locations. The `location
/users/` block that would carry this setting is edited by hand on the box and is in no file
here.

So there was nothing to set, and I did not invent a file to set it in. Instead the required
setting is now in **four places an operator will actually meet it**:

1. **`CONTRIBUTING.md` → "Pre-deploy checklist: photo uploads (`client_max_body_size`)"** —
   its own section beside the WHIP pre-deploy checklist, stating up front that the config is
   not in the repo, giving `client_max_body_size 12m;` (12 not 10: the multipart envelope
   rides on top of the file's bytes and this directive measures the whole body), explaining
   the failure mode (nginx answers its own 413, `apps/api` never sees the request and logs
   nothing), and a `curl` that verifies it **through the public origin** — with the note that
   a `400` is the success case and a `413` the failure.
2. **The gate checklist, new step 9a**, with the same check phrased as something to click.
3. **Spec §10**, as a validation requirement rather than a footnote.
4. **`infra/nginx/live-hls.conf.template`**, as a clearly-marked comment pointing at
   CONTRIBUTING.md — deliberately *not* as a directive, since a `client_max_body_size` inside
   the `/live/` location would apply to HLS segments and to nothing that uploads anything.

### The client half

`describeUploadFailure` branched only on 400, so a 413 fell through to
"Permintaan tidak dapat diproses. Coba lagi." — the retry-forever loop Task 8's I1 killed,
back through a status nobody enumerated. 413 now has its own branch, matched on the
**status** rather than a code, precisely because the most likely sender is nginx and its
error page is HTML, not JSON:

> **"Foto terlalu besar. Pilih foto berukuran di bawah 10 MB."**

Pinned twice: in `errorCopy.test.ts`, and end-to-end in `PostComposer.test.tsx` against a
real HTML 413 `Response`. Deleting the branch reddens both.

---

## I3 — spec §10's "rejected before it is read into memory". **I implemented it.**

Chosen over amending the spec because Hono ships `bodyLimit`, `errorHandler` already forwards
`HTTPException` with its status (`error-handler.ts:21-25`), and a 413 from the API is exactly
what the client's new 413 branch already handles — so the implementation cost about four
lines and made two things consistent instead of one thing honest.

`bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 KB })` sits on `POST /media` after `requireAuth`
(a stranger is still turned away before this process reasons about their body) and ahead of
`c.req.formData()`. It refuses on the declared `Content-Length`.

**The 64 KB is deliberate and I amended §10 to describe it**, because setting the ceiling
*equal* to the file limit would refuse a file of exactly 10 MB — the multipart envelope
pushes the body over — and replace `UploadMedia`'s Bahasa sentence naming the limit with a
bare 413. So: grossly oversized bodies are never buffered, and a file just over the line
still gets the good refusal. §10 now says that rather than implying a single clean rule.

Also fixed while here: a POST with a non-multipart body used to reach `errorHandler` as an
uncaught `TypeError` and become a **500**. It is now a 400 with the missing-file code.

---

## The error code on the wire — the "honest fix" the ledger deferred

`UPLOAD_ERROR_CODE` in `packages/shared/src/media.schema.ts`:
`media_missing_file`, `media_too_large`, `media_too_many_pixels`, `media_unsupported_format`.

- `AppError` gained an optional `code`; `errorHandler` emits `{ error, code }` when there is
  one and the bare `{ error }` when there is not, so no existing response body grows a key.
- `domain/image.ts` gained an abstract `ImageRejectedError` base carrying the code;
  `UnsupportedImageError` and the new `ImageTooManyPixelsError` extend it. `routes/media.ts`
  matches the **base**, so a fifth refusal reaches the wire labelled without the route
  changing — which is the exact failure being repaired.
- `UserApiError` carries `code`; `readError` lifts it uninterpreted, and leaves it undefined
  when the body is not JSON (nginx's 413 page lands there).
- `describeUploadFailure` branches on the code. **An unlabelled 4xx now falls back to the
  general sentence rather than guessing** — the inference is gone, not relocated.

Codes are asserted as **literals** on both sides, never as `UPLOAD_ERROR_CODE.x`: they are a
wire contract, and renaming the constant must redden something.

`MAX_UPLOAD_BYTES` moved to `packages/shared` in the same commit, read by the composer, the
route's `bodyLimit` and the use case alike — the precedent being `MAX_POST_BODY_LENGTH`
exactly. Both former copies were pinned to literals, so the move reddened nothing and the
literals still pin the value.

---

## I4 — the sweep and the claim

Three changes, all pinned, all mutation-verified:

1. **`deleteById` → `deleteIfUnclaimed(id): Promise<boolean>`**, with the guard inside the
   DELETE (`WHERE id = ? AND post_id IS NULL`) rather than a read-then-delete, which would be
   the same TOCTOU it exists to close. *Mutation: dropping `isNull(postMedia.postId)` reddens
   "refuses to delete a row that has been claimed since it was listed".*
2. **`claim` returns how many rows it actually attached** (via `.returning({ id })`, not a
   driver rowcount), and `CreatePost`/`EditPost` refuse loudly when that is short of what they
   asked for — `ConflictError`, Bahasa, actionable: *"foto sudah tidak tersedia, silakan
   unggah ulang"*. The post row does already exist on create; that is the honest cost of the
   write and the claim not being one unit of work (M1), and it is documented at the guard. A
   loud wrong-ish status beats silent photo loss. *Mutation: `claimed += 1` instead of
   `+= updated.length` reddens the repository's short-count test.*
3. **`sweepOne` re-reads the row immediately before removing its bytes.** The dangerous window
   was the whole duration of a 500-row page; it is now one storage call. A row claimed in that
   interval is `skipped` — a new count on `OrphanSweepResult` and on the summary line, so an
   operator can see it. *Mutation: neutering the re-read reddens "skips a row that has been
   claimed since the page was listed".*

The last instant — a claim landing between the re-read and the DELETE — is not closed, and I
did not close it. Doing so needs the row deleted before the objects, which inverts the
`objects-before-row` order that class is built on and trades a vanishingly rare loud failure
for a permanent byte leak on any storage error. The review said that inversion should be
argued on its own; it still should. What happens instead: the conditional DELETE keeps the
row (so the post's `media` stays intact and consistent), the bytes are gone, and the sweep
logs a line saying exactly that. Recorded in spec §12 rather than left in a code comment.

The no-progress guard now counts `deleted + skipped` as progress — a page of rows that were
all claimed since listing does leave the result set, and counting only deletions would have
broken out of a walk that was in fact progressing.

---

## `scripts/deploy.sh`

The API reloads (and its health poll passes) **before** the web bundle is published. The
white-screen window is empty for this deploy — migration 0023 creates `post_media` in the
same run — so the argument is the rollback one: an old API under a new bundle seeds
`EditComposer` with an empty strip and `saveEdit` then sends `mediaIds: []`, **stripping a
post's photos**. The reverse pairing is inert (Zod strips request keys an old client never
sends; an old client never reads `media`). `bun run build` stays where it was, so a build
failure still stops the deploy before anything on the box is touched. `bash -n` clean.

---

## Minors

| # | Done |
|---|---|
| M1 | Documented at `requireFullyClaimed` — the post write and the media claim are not one unit of work, and what that costs when the claim comes up short. |
| M2 | The closed projection is now asserted on `GET /users/feed`, on `GET /users/:handle/posts` and on the `PATCH` response. **Mutation-verified**: adding `bucketKey` to `toMediaView` reddens the new test as well as the old one. |
| M3 | `PostCard.tsx` and `styles.css` cite §2 for the media slot and for thumbnails-are-Phase-4. |
| M4 | `PostView.media`'s docstring no longer claims neither reader writes `?? []`; both do, deliberately, and it says why. |
| M5 | `MediaStrip`'s `error` comes from `describeUploadFailure`. |
| M6 | `vite.config.ts` — thumbnails arrive as `<img src>`, not `fetch()`. |
| M7 | The two lines that could not fail are gone (`EditPost` holds no storage port); `media.deletes` is named as the guard that can. The unused `FakeMediaStorageAdapter` import went with them. |
| M8 | The gate checklist's cleanup SQL was **wrong** — both `post_media` FKs and `post.author_id` are `ON DELETE no action`, so `DELETE FROM app_user` errored. Replaced with the three ordered statements. Step 0 now records that `vite.gate.config.ts` is untracked and why it points at 3004. |
| M9 | Spec §12 says plainly that deleting a post does not retract its photo. |
| M10 | `upload-media.test.ts` builds its oversized input from the literal `10 * 1024 * 1024 + 1`, and asserts the wire code. |

---

## Verification, and what I did not take on trust

- **Every mutation listed above was actually run**, after committing, and reverted with
  `git checkout --` each time; the tree was confirmed clean after each.
- **The layout numbers are from a real browser**, three CSS variants × 5 counts × 2 widths ×
  before/after load. No dev server, no bound port — a local `file://` page and
  `chrome --headless --dump-dom`.
- **The memory numbers are from real bytes** through the real `processUpload` (HEAD's, for
  the "before" column), peak RSS by `/usr/bin/time -v`.
- **The nginx claim was grepped, not assumed** — `client_max_body_size` appears nowhere in
  the repository before this change, and `live-hls.conf.template` is a fragment by its own
  declaration.
- **The FK claim in M8 was read out of migration `0023`**, not inferred.

`git status --short` is empty. `.superpowers/` is gitignored and was never force-added; the
only files written outside the repository are the browser harness and the memory-measurement
scripts, under the session scratchpad.
