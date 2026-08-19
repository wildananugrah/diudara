# Phase 4 (images) — SCOPED re-review of the final fix wave

Range `ba15500..8986416`, branch `feat/images`, 4 commits / 35 files / 1,315 insertions.
Scope: the fix diff only. The rest of the branch was reviewed in `final-review.md` and is not
re-opened here.

## Verdict

| Finding | Verdict |
|---|---|
| **C1** — every image renders at the stored full-image pixel height | **ADDRESSED** (measured) |
| **C2** — a single image reserves zero height | **ADDRESSED** (measured) |
| **I1** — the pixel bomb | **ADDRESSED** (measured on bytes I built myself) |
| **I2 (client)** — a 413 gets the generic retry sentence | **ADDRESSED** (mutation-verified) |
| **I2 (server/nginx)** — `client_max_body_size` | **PARTIALLY ADDRESSED** — see the judgement below |
| **I3** — §10's "rejected before it is read into memory" | **ADDRESSED** (verified end to end) |
| **I4** — the sweep/claim race | **ADDRESSED** (mutation-verified; residue confirmed) |
| wire error code + `MAX_UPLOAD_BYTES` → `packages/shared` | **ADDRESSED** |
| `deploy.sh` reorder | **ADDRESSED** |
| minors M1–M10 | **ADDRESSED** (M2 mutation-verified) |

**Suites, re-run here:** api **2165 / 0** (237.3 s), web **750 / 0** (17.9 s), worker **52 / 0**,
shared **85 / 0**, `apps/web/src/test/` **12 / 0**. All four workspaces `tsc --noEmit` clean.
Every number the fixer reported reproduces exactly.

**Five new items** found in the fix diff, none of them a blocker: one visible layout defect the
fix leaves standing (and mis-describes), two stale comments the wave itself created, one wrong
arithmetic claim in a docstring, and one new user-facing failure mode with vague copy. Details
after the findings.

---

## C1 + C2 — MEASURED, not read

Headless Chrome `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`, `--headless=old
--dump-dom`, a local `file://` page, **no server and no bound port**. The branch's own
`styles.css` linked verbatim; `PostCard`'s own markup (`<img width=1200 height=1600 alt="">`
inside `.post-card-media[data-count=N]`).

Two rigs, because the fixer's numbers and the review's numbers disagreed and neither is the
production geometry:

- **`page`** — the real structure: `main.user-page.beranda-page > article.post-card >
  .post-card-media`. `.user-page` is `max-width: 36rem; padding: 2.5rem 1.25rem`, so the media
  column is **350 px at a 390 px viewport** and **536 px at 1440 px**, never the viewport width.
- **`bare`** — a container at exactly the viewport width. This is the fixer's rig, reproduced so
  its numbers can be checked directly.

The viewport is a real 390 px / 1440 px: headless Chrome clamps `--window-size` to a 500 px
minimum, so the page under test is loaded in a **sized iframe** and measured from the parent.
"Before load" is the `<img>` with its `width`/`height` attributes and **no `src` yet** — the same
layout input a pending network fetch gives. "After load" is measured after every `load` event
plus two `requestAnimationFrame`s, with `naturalWidth` asserted `1200x1600` so the images
provably landed.

### Shipped CSS (`8986416`) — 390 px viewport

| count | rig `page` (production) before → after | rig `bare` (fixer's) before → after |
|---|---|---|
| 1 | container **350×466.66** → **350×466.66** | **390×520** → **390×520** |
| 2 | 350×173, tiles 173×173 → identical | 390×193, tiles 193×193 → identical |
| 3 | 350×350, tiles 173×173 → identical | 390×390, tiles 193×193 → identical |
| 4 | 350×350, tiles 173×173 → identical | 390×390, tiles 193×193 → identical |
| 5 | 350×291, tiles 173×173 ×2 + 114×114 ×3 → identical | 390×324.34, 193×193 ×2 + 127.33 ×3 → identical |

### Shipped CSS — 1440 px viewport

| count | rig `page` before → after | rig `bare` before → after |
|---|---|---|
| 1 | **536×714.66** → **536×714.66** | 1440×1920 → 1440×1920 |
| 2 | 536×266, tiles 266×266 → identical | 1440×718, tiles 718×718 → identical |
| 3 | 536×536, tiles 266×266 → identical | 1440×1440, tiles 718×718 → identical |
| 4 | 536×536, tiles 266×266 → identical | 1440×1440, tiles 718×718 → identical |
| 5 | 536×446 → identical | 1440×1199.34 → identical |

### Pre-fix stylesheet (`ba15500`), same rig, 390 px — the bug reproduced

| count | rig `page` | rig `bare` |
|---|---|---|
| 1 | 350×**1600** | 390×**1600** |
| 2 | 350×**1600**, tiles 173×**1600** | 390×**1600**, tiles 193×**1600** |
| 3 | 350×**3204** | 390×**3204** |
| 4 | 350×**3204** | 390×**3204** |
| 5 | 350×**3204** | 390×**3204** |

### The four things asked

- **No box renders at the stored pixel height any more.** Confirmed at every count and both
  widths. The `1600`/`3204` column is gone.
- **A single image reserves a sensible non-zero height before load.** `page` **350×466.66**,
  `bare` **390×520** — both exactly 4:3 of the column width, i.e. the stored 1200:1600 ratio
  (350 × 1600/1200 = 466.66; 390 × 1600/1200 = 520). The fixer's reported 390×520 reproduces
  exactly in its own rig.
- **Multi-image tiles are square.** 173×173 / 193×193 / 266×266 / 718×718 at every count ≥ 2.
- **Nothing moves between pre-load and post-load.** Container AND per-tile boxes are byte-identical
  in every one of the 20 (rig × count × width) cases. This is the point of the reserved dimensions
  and it holds.
- **Nothing overflows.** `scrollWidth - clientWidth` and `scrollHeight - clientHeight` are `0` on
  every media container, and the iframe document's `scrollWidth` equals its `clientWidth`
  (390 / 1440) before and after load — no horizontal page scroll at either width.

**C1 ADDRESSED. C2 ADDRESSED.**

### N1 (new, minor, but visible) — the three-image mosaic still renders a hole, and the report describes it wrongly

`apps/web/src/styles.css:1219` (`[data-count="3"] img:first-child { grid-row: span 2 }`).

The fix report's "one residual" says the row-spanning first tile "measures 390×390 rather than its
final 193×390". **There is no such final state.** Measured, both before and after load, at both
widths, in both rigs: the first tile is **square** — 173×173 (page) / 193×193 (bare) — inside a
grid area that is 350/390 tall. Screenshotted to be sure: the bottom-left quadrant of a three-image
post is **empty background**. `align-self: stretch` does not apply to replaced elements, so
`aspect-ratio: 1/1` wins and the item never fills the area it spans.

This is **not a regression** — the pre-fix CSS had the same structural hole, taller — and it is
outside C1/C2's letter, which asked about container geometry and reflow. But the "one large + two
stacked" mosaic that `styles.css:1163-1168` describes at length still does not render, and the fix
report claims it does.

Measured one-line fix, no reflow introduced:

```css
.post-card-media[data-count="3"] img:first-child { aspect-ratio: auto; height: 100%; }
```

With it, `bare` count=3 becomes `container 390×390, tiles 193×390, 193×193, 193×193` — before AND
after load, identical — which is exactly the geometry the fix report already claims. Recommend
either taking the line or correcting the report and the CSS comment.

### N2 (new, minor) — the shipped comment's numbers are the fixer's rig, not the page

`styles.css:1199-1200` and gate step 6 say "container 390px … count=1 390x520". On the real
`/beranda` at a 390 px viewport it is **350×466.66**, because `.user-page` has 1.25rem of padding
each side. The shape is right and the ratio is right; the absolute numbers describe a container
the app never renders. Worth one word ("in a 390px-wide container") so a future reader measuring
against it does not think something regressed.

---

## I1 — the pixel bomb. Measured on bytes I constructed.

Fixtures built by me, not reused: `sharp({create})` → PNG, verified via the IHDR bytes.
`/usr/bin/time -v`, one process per run, `processUpload` called directly — HEAD's version, and
`ba15500`'s extracted with `git show`, for the before column.

| input | wire | `ba15500` | `8986416` |
|---|---|---|---|
| **16000×16000 Adam7-interlaced PNG** (256 MP, IHDR interlace byte = `01`) | **782 KB** | **928 MB RSS / 19.5 s — ACCEPTED** | **70.6 MB / 0.17 s — REFUSED** |
| 7000×7000 PNG (49 MP) | 153 KB | 137 MB / 1.2 s — accepted | 68.0 MB / 0.16 s — refused |
| 8000×6000 JPEG (48 MP, noise) | 28.9 MB | — | 96.1 MB / 0.17 s — refused |
| 7000×5700 JPEG (39.9 MP, noise) | 25.5 MB | — | 118 MB / 1.8 s — **accepted** |
| 4000×3000 JPEG (12 MP, noise) | 8.4 MB | — | 114 MB / 1.3 s — **accepted** |
| 4000×3000 JPEG (12 MP, flat) | 69 KB | 88 MB / 0.6 s — accepted | 91.2 MB / 0.6 s — **accepted** |

**The headline reproduces the fixer's:** a **782 KB** upload took the pre-fix API to **928 MB of
RSS and 19.5 s of CPU** and was accepted. (The fixer reported 998 MB / 13.5 s from a 748 KB file of
the same shape — same magnitude, and its point about interlacing is right: my first attempt used
sharp's `interlace: true`, which PNG ignores — the flag is `progressive: true` — and the resulting
sequential 256 MP PNG cost only 224 MB because libvips streams it. The Adam7 file is the real
weapon.)

- **The bound refuses before decoding.** 0.17 s versus 19.5 s, and 70.6 MB peak RSS versus 928 MB —
  70 MB is the bun+sharp process floor (the 12 MP control, which is *accepted* and fully decoded,
  peaks at 91 MB). Reading the code agrees: the check sits on the `sharp(bytes).metadata()` header
  read that already ran, before any `.toBuffer()` (`apps/api/src/domain/image.ts:103-104`).
- **The refusal is distinct and actionable, in Bahasa:** `"Resolusi foto terlalu besar (maksimal 40
  megapiksel). Perkecil ukuran foto lalu unggah ulang."`, `code=media_too_many_pixels`. Not the
  generic sentence, and deliberately not the byte-cap sentence.
- **A legitimate large photo is still accepted.** 12 MP accepted; 39.9 MP accepted (0.1 MP under
  the bound, so the boundary is where it claims to be).
- **Mutation:** deleting `if (width * height > MAX_UPLOAD_PIXELS) …` reddens **4 tests** across
  `image.test.ts` and `media.test.ts`. Instructive detail: with the check gone the belt-and-braces
  `limitInputPixels` still refuses, but as sharp's raw English `"Input image exceeds pixel limit"`
  with no `code` — which is precisely the failure the explicit check exists to avoid.
- Fixture verified: `oversized-dimensions.png` is 5,584 bytes, 9000×5000 = 45.0 MP.

**ADDRESSED.**

### N3 (new, minor, documentation) — the "48 MP sensor" claim is arithmetically wrong

`packages/shared/src/media.schema.ts:43-45`: *"a 48 MP sensor's full-resolution JPEG is 0.8×"* the
40 MP bound. 48 / 40 = **1.2**, and measured above, an 8000×6000 JPEG is **refused**. 48/50/108 MP
sensors are extremely common in the Indonesian mid-range; they pixel-bin to 12 MP by default, so
the ordinary path is fine, but "full-resolution mode" is a real button and this docstring says it
is covered when it is not. The refusal is at least actionable ("perkecil ukuran foto"), so this is
a wording fix, not a bound change — unless the owner would rather raise the bound to ~55 MP, which
the measurements support (a 55 MP accepted decode still peaks well under 200 MB).

---

## I2 — nginx's `client_max_body_size`

### The client half — ADDRESSED

`describeUploadFailure` matches **413 on the status**, ahead of the code switch, because the likely
sender is nginx and its error page is HTML with no `code` to read. Verified end to end rather than
by reading: through the real route, an 11 MB body returns `413 "Payload Too Large"` as **plain
text**, so `readError` leaves `code` undefined and the status branch is the only thing that can
fire. **Mutation:** deleting `if (err.status === 413) return TOO_LARGE;` reddens exactly two named
tests — `errorCopy.test.ts` "answers a 413 with something actionable, whoever sent it" and
`PostComposer.test.tsx` "says a photo is too big when the PROXY refuses it, not 'coba lagi'" —
and the second one's received value is the old `"Permintaan tidak dapat diproses. Coba lagi."`

`apps/web/src/test/no-raw-server-errors.test.ts` and the other two guard files: **12 / 0**.

### The server half — my honest judgement: **the hand-off is not good enough yet, and it is two lines from being good enough**

What the fixer says is true and I checked it: `client_max_body_size` appears nowhere in the
repository before this change; `infra/nginx/live-hls.conf.template` declares itself a fragment of
four `location` blocks; the `location /users/` block is not in this repo. Writing the requirement
down rather than inventing a config file to hold it was the right call, and the CONTRIBUTING.md
section is genuinely good — it names the failure mode, explains `12m` rather than `10m`, and gives
a `curl` **through the public origin** with "400 is the success case" spelled out. The gate
checklist's 9a, spec §10 and the template's cross-reference comment are all real and all correct
(the checklist is `docs/superpowers/sdd/...`, i.e. tracked and shipped — not the gitignored path).

**But the question asked is the right one.** The operator does not run CONTRIBUTING.md. They run
`scripts/deploy.sh` — via `.github/workflows/deploy.yml`, on a push to `main`, on a self-hosted
runner. That script mentions nginx exactly once, to say it does **not** touch it. Nothing in the
path an operator actually walks says the word `client_max_body_size`. And the failure is silent on
the server side by construction: nginx answers its own 413, `apps/api` logs nothing, `pm2 logs` is
empty. The first signal is a user who cannot post a photo.

**What I would do differently — and the precedent is already in the file.** `deploy.sh` already
polls `/health` for up to 60 s and, on failure, prints a paragraph pointing at
`CONTRIBUTING.md`'s "Live streaming (MediaMTX)" section. The same shape closes this, non-fatally,
after the health poll:

```bash
# nginx's default client_max_body_size is 1 MB; POST /users/media accepts 10 and a
# phone photo is 2-5. The proxy config is not in this repo — see CONTRIBUTING.md,
# "Pre-deploy checklist: photo uploads". A warning, never a failure: this script
# does not own nginx and must not refuse to deploy over it.
if ! sudo nginx -T 2>/dev/null | grep -q 'client_max_body_size'; then
  echo "WARNING: no client_max_body_size in nginx's effective config." >&2
  echo "  Photo uploads will fail with a 413 the api never sees. Add" >&2
  echo "  'client_max_body_size 12m;' to the server/location block that proxies" >&2
  echo "  /users/ and reload. See CONTRIBUTING.md, 'Pre-deploy checklist: photo uploads'." >&2
fi
```

Two other cheap improvements, in order of value: (a) amend `deploy.sh`'s header, which currently
says only "Does NOT touch nginx/TLS", to add "…and photo uploads REQUIRE one nginx setting it does
not manage — see CONTRIBUTING.md"; (b) `.github/workflows/deploy.yml` could surface the same
warning in the run log. Without (a) or the check, the documentation is in four places an operator
who already knows to look will find, and zero places an operator who does not will.

I would not block the merge on this — the client half means a misconfigured box now tells the
person something true rather than looping them — but I would not call the hand-off finished
either. **PARTIALLY ADDRESSED.**

---

## I3 — the body limit

`bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 KB })` sits on `POST /media` after `requireAuth` and
ahead of `c.req.formData()` (`apps/api/src/routes/media.ts:79-86`). Spec §10 now describes the
margin rather than implying a single clean rule. Code and spec agree.

Verified through the real app (a temporary test file, since the shipped suite pins the 413 and the
use-case refusal but not the *boundary* between them; the file was deleted and the tree
re-confirmed clean):

| body | result |
|---|---|
| multipart with a file of **exactly** 10,485,760 bytes | **201** — the envelope margin does its job; without it this would be a bare 413 |
| multipart with a file of 10,485,761 bytes | **400** `{"error":"Ukuran foto maksimal 10 MB.","code":"media_too_large"}` |
| multipart with an 11 MB file | **413** `Payload Too Large` (plain text, no code) |

So a file just over 10 MB gets the Bahasa sentence naming the limit, not a bare 413 — exactly the
claim. And the bare 413 that a grossly oversized body does get is handled by the client's status
branch. The non-multipart body that used to become a 500 is now a 400 with
`media_missing_file`; pinned in `media.test.ts`.

**ADDRESSED.**

---

## The wire error code, and `MAX_UPLOAD_BYTES`

**The client branches on the code, not the status.** `describeUploadFailure` switches on
`err.code`; the `default` arm — which covers `media_missing_file` *and every unlabelled 4xx* —
delegates to `describeRequestFailure`. The inference is gone, not relocated, and
`errorCopy.test.ts:196` pins it ("does not guess when a 400 arrives with no code at all").

Every refusal this route can produce, and the sentence it produces:

| refusal | wire | sentence |
|---|---|---|
| no `file` part / non-multipart body | 400 `media_missing_file` | general (unreachable from this client) |
| over `MAX_UPLOAD_BYTES` | 400 `media_too_large` | "Foto terlalu besar. Pilih foto berukuran di bawah 10 MB." |
| over `MAX_UPLOAD_PIXELS` | 400 `media_too_many_pixels` | "Resolusi foto terlalu besar. Perkecil ukuran foto lalu unggah ulang." |
| not JPEG/PNG/WebP | 400 `media_unsupported_format` | "Format ini tidak didukung. Gunakan JPG, PNG, atau WebP — foto iPhone (HEIC) belum didukung." |
| `bodyLimit` / nginx | 413, no code | "Foto terlalu besar. Pilih foto berukuran di bawah 10 MB." |

Four distinct sentences over five failures; the two that share one are the two "too big" cases,
which is right. `errorHandler` spreads `code` in only when there is one, so no existing response
body grew a key. The route matches `ImageRejectedError`, the base — a fifth refusal reaches the
wire labelled without the route changing.

**`MAX_UPLOAD_BYTES` has one home.** `packages/shared/src/media.schema.ts:20` is the only
declaration in the repo; `apps/api/src/domain/image.ts:13` and `apps/web/src/user/apiClient.ts:707`
both **re-export** it. `MAX_UPLOAD_PIXELS` likewise. Every `10 * 1024 * 1024` that survives is in a
test asserting the literal (`media.schema.test.ts`, `image.test.ts`, `upload-media.test.ts`,
`PostComposer.test.tsx`) — which is the rule, not a duplicate.

**ADDRESSED.**

---

## I4 — the sweep/claim race

**Mutation-verified, three ways, each reverted and the tree re-confirmed clean:**

| mutation | reddens |
|---|---|
| drop `isNull(postMedia.postId)` from `deleteIfUnclaimed`'s WHERE | `DrizzleMediaRepository > refuses to delete a row that has been claimed since it was listed` (expected `false`, received `true`) |
| `claimed += 1` instead of `claimed += updated.length` | `DrizzleMediaRepository > reports a short count when one of the ids has vanished` (expected 1, received 2) |
| remove the `findById` re-read from `sweepOne` | `SweepOrphanMedia > skips a row that has been claimed since the page was listed, bytes and row intact` (`claimed-late` reappears in `removedIds`) |

**`claim` now notices when it claims nothing.** It returns the count via `.returning({ id })` — not
a driver rowcount — and `requireFullyClaimed` throws `ConflictError("foto sudah tidak tersedia,
silakan unggah ulang")` on a short count, in both `CreatePost` and `EditPost`. The M1 cost (the
post row already exists on create) is documented at the guard.

### The deliberate residue

**(a) Recorded in the spec: yes.** `docs/superpowers/specs/2026-08-18-images-design.md` §12, honest
limitations, in full: the sweep removes bytes before the row and re-reads the row immediately
before doing so; a claim landing in that instant keeps its row and loses its bytes; closing it
needs objects-after-row, which trades a rare loud failure for a permanent byte leak on any storage
error; deliberately not taken in this phase. It also says the sweep logs it — and it does, naming
the media id and saying the post now references media that will 404.

**(b) Genuinely narrower: yes, by construction.** The old window was *the entire time between
`listUnclaimedBefore` returning a page and `sweepOne` reaching that row* — up to 500 rows of
storage round-trips. The new window is *the duration of one `storage.remove` call*, and the loss it
can still cause is strictly smaller: the row survives (the conditional DELETE refuses), so the
post's `media` stays internally consistent and only the bytes are gone — where before, row and
bytes both vanished silently. Loud and partial has replaced silent and total.

**ADDRESSED.**

### N4 (new, minor→moderate) — the new 409 is never shown to the person

`requireFullyClaimed` throws a `ConflictError` (409) with a genuinely actionable Bahasa sentence.
`PostComposer.tsx:374` renders a failed submit through **`describeRequestFailure`**, whose 409 arm
is `"Permintaan tidak dapat diproses. Coba lagi."` So the good sentence never reaches a screen, and
retrying re-sends the same `mediaIds` — which now fail `requireAttachable` instead, producing
another vague sentence. That is the retry-forever shape I2 was raised about, reintroduced by this
fix wave in a rarer place. Also worth noting: on create the post row already exists, so the person
who "retries" ends up with a duplicate post.

Rare (it needs the race), and strictly better than the silent loss it replaced, so not a blocker.
The clean fix is the one this wave already built: give `ConflictError` a code here
(`post_media_vanished`) and one branch in the composer's submit path, or have `describePostFailure`
special-case 409 on this route.

---

## The rest

- **`scripts/deploy.sh`** — the API reload **and its 60 s health poll** now complete before the web
  bundle is published; the bundle copy moved to after the poll's `exit 1`. `bun run build` stayed
  where it was, so a build failure still aborts before anything on the box is touched. The comment
  block argues the rollback exposure (`mediaIds: []` stripping photos) rather than the white-screen
  one, which is the stronger argument. `bash -n` clean. **ADDRESSED.**
- **Minors M1–M10** — all present. M2 **mutation-verified**: adding `bucketKey` to `toMediaView`
  reddens both the old projection test and the new one covering `GET /users/feed`,
  `GET /users/:handle/posts` and the `PATCH` response. M8's FK claim checked against migration
  `0023`: both `post_media` FKs are `ON DELETE no action`, so the old one-line cleanup SQL really
  did error; the replacement's three statements are in the right order. M7's two unfalsifiable
  lines are gone along with the now-unused import.
- **No DOM node on either side of a failable assertion** anywhere in the fix diff. The new composer
  test asserts `screen.getByRole("alert").textContent` against a string — checked by grepping every
  added `expect(` line in the range.

### N5 (new, minor) — two comments the wave itself falsified

`apps/web/src/user/PostCard.tsx:88-89` and `apps/web/src/user/PostCard.test.tsx:143-144` both still
say `deploy.sh` "swaps the bundle before reloading the API" / "copies the new web bundle into
nginx's serving directory BEFORE it reloads the api process". `8986416` inverted exactly that. The
`?? []` guards those comments justify are still correct and still wanted — the rollback pairing is
the reason now — but the stated reason is false as of the commit that stated it. Same class as the
M4/M5/M6 drift this wave was cleaning up.

---

## Tree

`git status --short` is **empty** and `git stash list` is empty. Every mutation was reverted with
`git checkout --` immediately after its run and the tree confirmed clean each time (six mutations:
`deleteIfUnclaimed`'s guard, `claim`'s counter, `sweepOne`'s re-read, the pixel bound, the 413
branch, `toMediaView`). One temporary test file
(`apps/api/src/routes/zz-rereview-margin.test.ts`) and one stray `apps/api/undefined/` directory —
created by a shell-quoting slip while generating fixtures — were both removed and the removal
verified. `.superpowers/` is gitignored and was not force-added; everything else written lives
under the session scratchpad.
