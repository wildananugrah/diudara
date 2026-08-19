# Phase 4 (images) — final whole-branch review

Range `663a359..ba15500`, branch `feat/images`, 27 commits / 69 files / 9,827 insertions.
Reviewed against `docs/superpowers/specs/2026-08-18-images-design.md` and the ledger's 32 rulings.

## Verdict

**FINDINGS MUST BE FIXED FIRST.** Four blockers, none of them found by a per-task review because none
of them are visible from inside one task:

- **two of them nobody could see without a browser** — the feed's image layout is broken at every
  image count, measured in real Chrome;
- **one nobody could see without running the pipeline against a hostile input** — a 200 KB PNG makes
  the API allocate 750 MB, a 450 KB one 1.4 GB, and nothing bounds it;
- **one nobody could see without looking outside the repository** — nginx's default
  `client_max_body_size` is 1 MB, so nearly every real phone photo will be refused by the proxy with
  a 413 the client describes as "Coba lagi".

Everything the eleven task reviews *did* cover holds up. Baselines re-measured on this machine:
**api 2148 pass / 0 fail** (223 s), **web 745 / 0**, **worker 50 / 0**, all four workspaces typecheck
clean. The closed projection survives mutation. No path leaks a bucket URL or key to a client. The
sweep's delete ordering and per-row isolation are right. The Bahasa/English split is consistent.

---

## Blockers

### C1 (Critical) — every image in the feed renders at the FULL image's pixel height. Measured.

`apps/web/src/styles.css:1179-1185`, with `apps/web/src/user/PostCard.tsx:99-116`.

`PostCard` writes `width={image.width} height={image.height}` on each `<img>` (correctly — spec §4
stores those columns so the feed reserves space). Those attributes are presentational hints for the
CSS `width` and `height` properties. `.post-card-media img` overrides `width` to `100%` but **never
sets `height`**, so the height hint wins and the box is as tall as the stored full-image height — up
to 1600 px. And because both axes are then definite, the `aspect-ratio: 1 / 1` declaration on the
very next line is **inert**: it never applies to anything.

Measured in headless Chrome (`~/.cache/ms-playwright/chromium-1234`), viewport 390 px, the branch's
real `styles.css` and `PostCard`'s real markup, images 1200×1600:

| count | rendered (this branch) | intended |
|---|---|---|
| 1 | container 445×**1600**, img 445×1600 | 445×593 |
| 2 | container 445×**1600**, tile 221×**1600** | tiles 221×221 |
| 3 | container 445×**3204** | 445×445 |
| 5 | container 445×**3204** | 445×370 |

Before the bytes land it is worse: the two-image tile measures **1600×1600**, overflowing its 221 px
grid column.

A five-image post occupies **3,204 px** of a 390 px phone screen instead of 370. The mosaic layouts
the CSS comment describes at length (`styles.css:1170-1178`) never render.

**Nothing in the suite can catch this.** happy-dom computes no layout; `PostCard.test.tsx` asserts
`data-count`, `src` and the `width`/`height` attributes and nothing about geometry. The gate
checklist's step 6 is the only thing between this and production, and its wording ("nothing
overflows", "the five-image case does not collapse") is aimed at a different failure.

**Fix:** add `height: auto;` to `.post-card-media img`. That single line is necessary but not
sufficient — see C2.

### C2 (Important) — the single-image case reserves ZERO space, and C1's obvious fix is what exposes it.

`apps/web/src/styles.css:1187-1189`.

`.post-card-media[data-count="1"] img { aspect-ratio: auto; }` discards the aspect ratio the UA
derives from the `width`/`height` attributes. With C1 fixed by `height: auto` alone, measured:

```
height:auto only →  count=1 container=445x0    ← nothing reserved until the byte arrives
                    count=2 221x221  count=3 445x445  count=5 445x370   ← correct
```

Zero reserved height on the **most common post shape** is exactly the reflow that `width`/`height`
are columns on `post_media` to prevent (spec §4, and `PostCard.tsx:102-106` says so in a comment).

**Fix, measured correct:** drop `aspect-ratio` from the base rule and scope the square to the
multi-image case.

```css
.post-card-media img { display: block; width: 100%; height: auto; object-fit: cover; background: var(--line); }
.post-card-media:not([data-count="1"]) img { aspect-ratio: 1 / 1; }
```

Measured with images not yet loaded: `count=1 445×593`, `count=2 221×221`, `count=3 445×445`,
`count=5 445×370`. Every case correct, and every case reserves its space before the byte arrives.

### I1 (Important) — a 446 KB upload makes the API allocate 1.4 GB. Nothing bounds pixel count.

`apps/api/src/domain/image.ts:34-68`, `apps/api/src/application/use-cases/upload-media.ts:21-27`.

The only size bound anywhere is `MAX_UPLOAD_BYTES` — bytes on the wire. `processUpload` then hands
the bytes to sharp with no `limitInputPixels` override, so sharp's default ceiling of **268 megapixels**
(16384²) applies. Measured on this machine, real `processUpload`, `/usr/bin/time -v`:

| input | wire size | peak RSS | wall |
|---|---|---|---|
| 8000×8000 solid PNG (64 MP) | **197 KB** | **754 MB** | 1.26 s |
| 12000×12000 solid PNG (144 MP) | **446 KB** | **1.41 GB** | 1.83 s |

Both were **accepted**, not rejected. The scaling is linear at ~9.8 MB of RSS per megapixel, so
sharp's own 268 MP ceiling permits roughly **2.6 GB per request** — from a file two orders of
magnitude under the 10 MB cap. `processUpload` also decodes the source twice (`image.ts:45` and
`:53`), doubling the CPU.

Any account — and signup is open — can kill the single API process on the VPS with a file that costs
nothing to upload, repeatedly. pm2 restarts it; the next request kills it again. The 10 MB cap does
not bound this at all, and spec §10 does not name a pixel limit, so this is a spec gap rather than a
spec violation — but it is a production hazard the whole-branch review is the right place to catch.

**Fix (~3 lines):** `processUpload` already reads `sharp(bytes).metadata()` before anything else.
Reject there on `width * height` above a bound (10–40 MP covers every phone camera in existence),
or pass `{ limitInputPixels }` to both `sharp()` constructors. Note the new refusal is a **fourth
400** on `POST /users/media` — see the triage of the deferred format-inference item below; these two
must be fixed in the same change.

### I2 (Important) — nginx will 413 nearly every real photo, and the person is told "Coba lagi".

`apps/web/src/user/errorCopy.ts:98-105`; the absent config is host-side.

There is **no `client_max_body_size` anywhere in this repository** — not in
`infra/nginx/live-hls.conf.template` (grepped: 0 hits, and it is a fragment scoped to `/live/`,
`/whip/`, `/webhooks/mediamtx/`), not in `scripts/deploy.sh` (which states it does not touch nginx),
not in CONTRIBUTING.md's long nginx section. **nginx's default is 1 MB.** The API accepts 10 MB, the
composer refuses only above 10 MB (`apiClient.ts:MAX_UPLOAD_BYTES`), and an ordinary phone photo is
2–5 MB. So in production the request never reaches the API: nginx answers **413** with its own HTML
error page.

`describeUploadFailure` special-cases only 400, so a 413 falls through to `describeRequestFailure`'s
vaguest sentence: **"Permintaan tidak dapat diproses. Coba lagi."** That is precisely the
retry-forever loop Task 8's Important 1 existed to eliminate for HEIC, reintroduced through a status
code nobody enumerated.

**The gate cannot catch it.** The checklist's step 0 runs `vite` on :5173 proxying straight to the
API — nginx is never in the path. This will first appear to real users.

**Fix:** (a) document `client_max_body_size 12m;` on the `/users/` location in CONTRIBUTING.md and
add it as an explicit step to the gate checklist, since the production nginx config is not in the
repo; (b) give 413 its own Bahasa branch in `describeUploadFailure` — "Foto terlalu besar untuk
diunggah" — so that if the box is ever misconfigured the person is told something true.

---

## Should fix

### I3 (Important) — spec §10's "rejected before it is read into memory" is not implemented.

`apps/api/src/routes/media.ts:59-64` calls `c.req.formData()` and then `file.arrayBuffer()`,
buffering the entire body; the 10 MB check runs afterwards in `upload-media.ts:21`. There is no
`bodyLimit` middleware on this route or anywhere in the app (grepped). Auth runs first
(`media.ts:58`), so this is bounded to signed-up accounts, and in production it will be masked by
whatever `client_max_body_size` ends up being — which is the same missing knob as I2. Either mount
Hono's `bodyLimit` on `POST /media` (it throws `HTTPException`, which `errorHandler` already
forwards with its status — `error-handler.ts:21-25`) or amend §10 to say the proxy is what enforces
the pre-read refusal. Pair it with I2.

### I4 (Important) — the sweep can delete a row and its bytes out from under a post that is claiming it.

`apps/worker/src/scheduled-passes.ts:262-265`, `apps/api/src/infrastructure/repositories/drizzle-media.repository.ts:92-94`.

This is the race the brief asked me to look for, and it is real, in one direction only:

1. `listUnclaimedBefore(cutoff, 500)` returns row R (`post_id IS NULL`, `created_at` older than 24 h).
2. Before `sweepOne(R)` runs, a `CreatePost`/`EditPost` claims R. `requireAttachable`
   (`write-post.ts:58-68`) reads `postId === null` and accepts; `claim` sets it.
3. `sweepOne` then calls `storage.remove(R)` — bytes gone — and `deleteById(R)`, which carries **no
   `post_id IS NULL` guard**. The row is gone too.

The post silently ends up with fewer images than the author sent, and nothing notices: `claim`
(`drizzle-media.repository.ts:52-62`) issues per-id UPDATEs and never checks how many rows it
actually touched, so a vanished id is a no-op.

The opposite ordering is safe — if the sweep wins the race, `findManyByIds` misses the row and the
request is cleanly refused with `"foto tidak ditemukan atau bukan milik Anda"`.

Preconditions: a row at least 24 hours old, still unclaimed when the pass lists it, claimed inside
the pass's own duration. A composer or an edit left open overnight on a phone is ordinary, and the
hourly cadence gives 24 chances a day. Low probability, silent data loss.

**Cheap mitigation (~5 lines), not the full fix:** make the delete conditional
(`DELETE ... WHERE id = ? AND post_id IS NULL`, returning whether it removed a row) and have `claim`
assert it updated as many rows as it was given. That converts silent loss into a loud one and closes
the row half; closing the byte half needs the row claimed for deletion before the objects go, which
inverts the pinned order and should be argued on its own. See the triage of the DB-backed sweep test
below — these two deferrals are the same seam.

---

## Minors (batch them; none blocks)

| # | Where | What |
|---|---|---|
| M1 | `write-post.ts:89-95`, `:136-139` | The post write and the media claim are not one unit of work. A failure between them leaves a post with no images and a 500; the author retries and creates a duplicate. `DatabaseExecutor` supports composing them and `claim` already opens its own transaction, so this is a choice — just an undocumented one. |
| M2 | `routes/posts.test.ts:147,675`, `post-views.test.ts:33,62` | Projection closure is asserted at the funnel and on two HTTP responses only. Mutation-verified: adding `bucketKey` to `toMediaView` (`post-views.ts:45`) reddens exactly 3 tests — `toPostView`'s key test, `ListFeed`'s use-case test, and the create-response route test. **Nothing** asserts the key set on `GET /users/feed`, `GET /users/:handle/posts` or the `PATCH` response. Safe today because there is one funnel; blind to a route-layer decoration. |
| M3 | `PostCard.tsx:76-77`, `styles.css:1180` | Spec citations still wrong after Task 9's fix round. The media slot and "thumbnails are Phase 4's job" are both **§2**; the card cites §3 and §5.1, the stylesheet cites §7/§12. |
| M4 | `apiClient.ts:806-808` | "neither of them writing `?? []` over a field the server always sends" — `PostCard.tsx:55` writes exactly that. Made false by Task 9's own fix round, as the ledger recorded. |
| M5 | `MediaStrip.tsx:20-21` | Says the composer builds `error` through `describeRequestFailure`; it has been `describeUploadFailure` since Task 8's fix round (`PostComposer.tsx:254`). Same drift class as M4. |
| M6 | `vite.config.ts:102-104` | "every one of these paths is reached only by `fetch()` … never by a browser navigation" — false since Task 9: thumbnails arrive as `<img src>`. Harmless (this entry declares no `bypass`), pure comment drift. Ledger's Task 8 M6, still open. |
| M7 | `write-post.test.ts:429-430` | `expect(await storage.get(...)).not.toBe(null)` in a test whose subject (`EditPost`) holds no storage port. The two lines cannot fail; line 428 (`media.deletes`) is the real guard. Ledger's Task 6 M1, confirmed by reading the constructor. |
| M8 | `gate-checklist.md` (Cleanup) | "Media rows go with the account" is **false**: migration `0023` declares both FKs `ON DELETE no action`, as does `post.author_id`, so `DELETE FROM app_user WHERE handle = 'uji_coba'` errors on a foreign-key violation. Also step 0 carries Phase 3's `vite.gate.config.ts` and port 3004 without Phase 3's note that the file is untracked and exists only on the owner's machine. |
| M9 | `routes/media.ts:92-133` | A soft-deleted post's media stays publicly fetchable by id — the handlers read the media row only. Consistent with §8 ("deleting a post leaves its media rows and objects untouched"), but §12's honest-limitations list never says that deleting a post does not retract the photo. One sentence in the spec. |
| M10 | `upload-media.test.ts:71` | Builds its oversized input from `MAX_UPLOAD_BYTES + 1` rather than a literal. Tolerable — `image.test.ts:106` pins the constant itself to `10 * 1024 * 1024`, so drift still reddens — but noted against the literal-values rule. |

---

## Triage of the deferred list

### 1. `MAX_UPLOAD_BYTES` duplicated between `apps/web` and `apps/api/src/domain/image.ts` — **SHIP**

Overturning half your reasoning, not the conclusion. Your framing was "the failure is safe in the
direction it can fail" — true for drifting **low** (a file refused that the server would have taken,
in Bahasa, naming the limit). Drifting **high** is not safe, and the ledger does not say so: an
oversized file then reaches the API, gets a 400, and `describeUploadFailure` labels it
*"Format ini tidak didukung… foto iPhone (HEIC) belum didukung."* — a confidently **wrong** sentence,
not a vague one. The duplication is not independently benign; it is one of the two legs the
format-inference argument stands on.

Both copies are pinned to literals (`image.test.ts:106` and `apiClient.test.ts`'s literal 10 MB), so
either edit reddens something. `packages/shared` is the right home and the precedent is exact
(`MAX_POST_BODY_LENGTH`, read by the composer, the route schema and the use case alike). But moving
it does **not** close the mislabeling risk — the error code does. Do the move in the same change as
item 2, not before merge on its own.

### 2. The upload failure copy infers rather than reads a signal — **FIX, together with I1**

I re-enumerated `POST /users/media` from source at HEAD rather than trusting the earlier review.
Exactly three 400s, and the argument holds today: missing file (`media.ts:61-63`, unreachable —
`uploadMedia` always appends), over-size (`upload-media.ts:21`, unreachable — the composer refuses
locally against a byte-exact copy of the same constant), unsupported format. No `bodyLimit`, and
non-`AppError` throws fall through to 500 (`error-handler.ts:33-35`), never 400.

**But the day the ledger names — "the day a fourth 400 appears" — is the day I1 is fixed.** A pixel
bound has to refuse something, and if it refuses as a `ValidationError` the client will call a
250-megapixel PNG an unsupported format. And I2's 413 is already a real fourth upload failure being
described by the vaguest sentence in the module. The honest fix you named is right and it is now
load-bearing rather than hypothetical: a machine-readable `code` alongside `error` on the wire, one
branch on the client. One server change, one client change, done with I1.

### 3. `scripts/deploy.sh` swaps the bundle before reloading the API — **SHIP for this deploy; fix soon**

The window is real and the script does create it (`deploy.sh:113-117` copies the bundle,
`:120` reloads pm2, then polls health for up to 60 s). But I do not agree it needs to be fixed
before merge, for a reason neither the Task 9 review nor the checklist states: **for this deploy the
window is empty.** Migration `0023` creates `post_media` in the same run, so during the skew no post
has any media — every post's `media` is `[]` whether the old API omits it or the new one sends it.
`PostCard.tsx:55`'s guard is sufficient, and both other readers are already safe (`postOwnerActions.tsx:261`
passes `post.media` into `seedImages(initialMedia ?? [])`, `PostComposer.tsx:169`).

It stops being empty on a **rollback** (an old API against a new bundle with real media rows), where
the exposure is worse than a blank page: `EditComposer` would seed an empty strip and `saveEdit`
would send `mediaIds: []`, stripping every photo from the post being edited. That is the argument
for reordering, and it is stronger than the white-screen one.

Reordering is strictly safe in the other direction — an old bundle against a new API is inert,
because Zod strips unknown keys and the old bundle never reads `media` — and it is about six lines
moved. Take it in the same pass as the minors; do not block the merge on it.

### 4. The orphan sweep has no DB-backed test — **SHIP, but re-scope it**

The placement argument holds (`SweepOrphanMedia` has no domain logic; `apps/worker` has no database
harness at all today, so this is a new capability rather than a fix). Keep the deferral.

But re-scope what the missing test is *for*. The ledger frames the gap as "a change to
`listUnclaimedBefore`'s semantics would leave both suites green". I4 above shows the sharper edge:
the untested seam is that `deleteById` is **unconditional**, and no test at either layer would notice
if it deleted a claimed row, because the fake repository and the real one agree about that too. Fix
I4 first. `deleteIfUnclaimed` returning a boolean is testable against the existing fakes, and once it
exists the DB-backed test is a nice-to-have rather than the only thing standing between you and
silent loss.

### 5. The smaller ones — **SHIP, batched**

`PostCard`'s and `styles.css`'s spec citations (M3), the `apiClient.ts` docstring (M4),
`MediaStrip`'s docstring (M5), the `vite.config.ts` comment (M6), the two unfalsifiable decoration
lines (M7). All comment and test hygiene, no behaviour, ~15 minutes as one commit. They should ride
along with the CSS fix rather than being a round of their own — which is what you already ruled at
Task 9, and it was the right call.

**`claim()` unpinned at one layer** (Task 6 M3 — the duplicate-id refusal pinned only at the use-case
layer) — **SHIP.** Task 6's fix round pinned the three refusal messages at the route layer verbatim
and asserted the shared one equal to itself (`f49bcbc`), and the use-case layer pins the rule. The
remaining asymmetry is stylistic.

---

## What I verified rather than took on trust

- **Baselines re-run here:** api **2148/0** (223.77 s), web **745/0** (18.70 s), worker **50/0**.
  `apps/web/src/test/` (all three guard files, including `no-raw-server-errors` and
  `no-hanging-dom-assertions`) **12/0**. All four workspaces `tsc --noEmit` clean.
- **The closed projection, by mutation.** Added `bucketKey: posts/<id>/full.webp` to
  `toMediaView` (`post-views.ts:45`): 3 tests redden, naming the leak
  (`Received + "bucketKey"`). Reverted; tree verified clean.
- **§5.1, by enumeration.** `MediaObject` is `{bytes, contentType}` with `contentType` a hardcoded
  literal in both adapters; `MediaRow` has no key or url column; the key layout exists only in
  `s3-media-storage.adapter.ts:36-38`; `MediaView` is three fields; `errorHandler` returns
  `err.message` for `AppError` only and `"internal server error"` otherwise, so an S3 failure
  carrying the endpoint cannot reach a body; the `AggregateError` from `remove()` names the media id
  and nothing else. The only place the bucket and endpoint appear is a boot log line
  (`bootstrap.ts` `selectMediaStorage`) and the worker's per-row failure line, both server-side and
  both through `redactLinks(safeErrorSummary(...))`. **No client-reachable path.**
- **The layout, in a real browser** — headless Chrome, 390 px, the branch's own stylesheet, four
  image counts, before and after load, three CSS variants. Numbers in C1/C2.
- **The pixel bomb, on real bytes** — `processUpload` against 64 MP and 144 MP PNGs, peak RSS by
  `/usr/bin/time -v`. Numbers in I1.
- **The 400 enumeration** on `POST /users/media`, read from source at HEAD.
- **The sweep/claim race**, traced through `listUnclaimedBefore` → `sweepOne` → `deleteById` against
  `requireAttachable` → `claim`, both directions.
- **The deploy window's actual exposure**, by checking which read sites touch `post.media`
  (two: `PostCard.tsx:55`, `postOwnerActions.tsx:261`) and what `post_media` contains during the
  first deploy (nothing — migration 0023 creates it in the same run).

## Tree

`git status --short` is empty. Every mutation was reverted with `git checkout --` and confirmed;
the only files written were scratch files under the session scratchpad and this report, which lives
under the gitignored `.superpowers/`.
