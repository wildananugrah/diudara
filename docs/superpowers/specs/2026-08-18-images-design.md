# Images — Design Spec

Phase 4 of the DIUDARA pivot. Parent specs: `2026-08-17-member-ui-design.md` (§5.1, §8) and
`2026-08-18-posts-and-feed-design.md` (which deferred images here and left `PostCard` a media slot
rather than a rewrite).

**Status: awaiting review.** Every decision here is the owner's, including the one this spec
originally assumed the other way — images are editable after posting, decided against a first draft
that said they were not (§3).

---

## 1. Purpose

People post photos. Everything else here follows from one sentence in the parent spec, §5.1:

> **The API must never send the media URL to a non-member.** Not a signed URL, not a blurred variant,
> not the original with a CSS filter over it. A browser that received the URL can fetch it, and a
> paywall enforced in a React component is not a paywall.

Phase 6 owns the paywall. **Phase 4's job is to make that paywall possible** — every byte must arrive
through an endpoint that is in a position to refuse. A design that hands out bucket URLs cannot be
gated later without being rebuilt, so the delivery shape is the load-bearing decision in this
document, not the upload.

## 2. What the parent specs already settle

Not re-opened here:

- **Images belong to posts.** Avatars and profile headers are not part of this phase.
- **`PostCard` gains a media slot.** It is not redesigned.
- **Delivery is through an endpoint, not a public bucket URL** (§5.1 above, and §8's "delivery
  through an endpoint that can check entitlement").
- **Thumbnails are Phase 4's job**, named explicitly in §8's table.
- **All user-facing copy is Bahasa Indonesia.**

## 3. Decisions taken during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Storage | **Biznet Gio NEO Object Storage** (S3-compatible), behind a `MediaStoragePort` | The owner already has the bucket. Bun 1.3.14 ships an S3 client that takes a custom endpoint, so this needs **zero new dependencies**. The port exists so the test suite runs with no bucket credentials, matching how email, messaging, payments and streaming are already wired. |
| Upload flow | **Two-step** — `POST /users/media` returns an id, the post references it | The upload runs while the person is still typing, so Kirim is instant on slow mobile data. A failed upload does not lose the text; a failed post does not lose the upload. |
| Thumbnails | **`sharp` at upload time** | The box has no image tooling at all — no ImageMagick, no vips, no ffmpeg. `sharp` ships prebuilt libvips binaries, so no apt install and no build step. It is the project's first native dependency, which §9 addresses. |
| Images per post | **5, from `MAX_POST_IMAGES`** | Owner's call, made after the trade-off below was put to them. |
| Limit configurability | **Runtime env var**, not a shared constant | Owner's call. `MAX_POST_BODY_LENGTH` stays a shared constant; the inconsistency is deliberate and §6 says how the web learns the value without a blocking fetch. |

**A post's images ARE editable after posting** — owner's decision, taken against a first draft of
this spec that assumed the opposite. The draft's argument was cost: the edit composer has to load
existing media, remove individual images, add new ones and reconcile `position`, which is the largest
single piece of UI work in a phase that is already building upload, storage, thumbnails and delivery
from nothing. That cost is real and is accepted, because the alternative is that a wrong photo can
only be fixed by deleting the post and losing its replies, timestamp and any links to it, while a
typo stays fixable — an asymmetry with no defence once you say it out loud.

Three consequences, each handled where it lands: `PATCH` takes the full desired media list (§5.2),
removed images are unclaimed rather than deleted (§8), and an image-only change still marks the post
edited (§5.3).

## 4. The model

A new `post_media` table. One row per image, per post.

| Column | Notes |
|---|---|
| `id` | uuid, and the id in every media URL |
| `post_id` | **nullable** — this is what makes the two-step upload work |
| `position` | 0-based, orders the images within a post |
| `width`, `height` | of the full image, after re-encoding — lets `PostCard` reserve space and not reflow the feed as images land |
| `byte_size` | of the full image, for the sweep in §8 and for knowing what is actually being stored |
| `created_at` | the sweep in §8 keys on this |

`post_id` being nullable is the whole design in one column: a row exists from the moment bytes land,
before any post does, and is **claimed** when the post is created. An unclaimed row is an orphan, and
§8 sweeps it.

Two objects per image in the bucket:

```
posts/<media_id>/full.webp
posts/<media_id>/thumb.webp
```

The media id is the only identifier that ever reaches a client. Bucket keys are derived from it, so
no bucket path is ever guessable from anything a browser has seen.

## 5. The endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /users/media` | required | multipart. Validates, re-encodes, uploads both sizes, returns `{ id, width, height }` |
| `GET /users/media/:id` | public *for now* | streams the full image |
| `GET /users/media/:id/thumb` | public *for now* | streams the thumbnail |
| `GET /users/limits` | public | `{ maxPostImages }` — see §6 |

`POST /users/posts` gains an optional `mediaIds: string[]`. It rejects the request when any id is
unknown, belongs to someone else, is already claimed by another post, or when there are more than
`MAX_POST_IMAGES` of them. `position` is the array's order.

`PATCH /users/posts/:id` gains the same field — see §5.2.

### 5.1 Why delivery proxies rather than redirects

The two `GET` routes read from the bucket and stream the bytes through the API. They do **not** 302
to the bucket and do **not** hand out a presigned URL.

Today those routes are public, because every post in Phase 3 is public — so proxying buys nothing
yet. It is still the right shape, and the reason is §5.1 of the parent spec: **the moment media
becomes gated, the check goes in one place that already sees every request.** A redirect or a
presigned URL cannot be retrofitted into a gate, because the URL outlives the check — a member can
forward it, and a browser that has it can fetch it forever. Phase 6 adding an entitlement check to
two handlers is a small change; Phase 6 rebuilding delivery is not.

The cost is honest and should be stated: **every image view spends VPS bandwidth twice** — bucket to
API, API to browser. §9 records what to do when that starts to hurt.

### 5.2 Editing a post's images

`PATCH /users/posts/:id` accepts `{ body, mediaIds }`, and **`mediaIds` is the complete desired list,
not a delta.** The client sends the final state — the images that should be on the post when the
request finishes, in the order they should appear. No add/remove/move verbs, so the same request
applied twice leaves the same post, and there is no way for client and server to disagree about what
"remove the second one" meant.

The ownership rules shift by exactly one clause from `POST`. An id is accepted when it is unknown to
no one, belongs to the editor, and is either unclaimed **or already claimed by this same post**. That
last clause is what lets an image stay put across an edit; without it, every edit would reject its
own existing images. An id claimed by a *different* post is still refused — otherwise editing a post
could steal media out of another one, including someone else's.

Reordering is free on the server: `position` is the array's order, so a reordered list is a valid
edit. **Whether the composer offers drag-to-reorder is a separate question, and Phase 4 says no** —
touch reordering on a 390px screen is its own piece of work. Adding and removing is enough to fix the
mistake people actually make, and the API is already able to reorder when a later phase builds the
interaction.

### 5.3 An image-only change still counts as an edit

Changing only the images sets `edited_at`, exactly as changing the text does, and `PostCard` shows
its existing `· diedit`. What a reader saw is not what they would see now, and the marker exists to
say so — attaching it to the text alone would let a post's content change silently, which is the
thing the marker is for.

### 5.4 `media` must be reserved

`/users/media/...` adds a new literal segment under `/users`, and `media` satisfies
`^[a-z0-9_]{3,30}$` — so it is registerable as a handle, and would shadow these routes.

**The route-derived guard in `routes/users.test.ts` will fail until `media` is added to
`RESERVED_HANDLES`.** That is the guard working as designed, on the very next phase after it was
written. Add `media` in the same commit as the routes.

## 6. The limit, and how the web learns it

`MAX_POST_IMAGES` is read from `apps/api/.env` at bootstrap, defaulting to 5, and validated as an
integer of at least 1 — a malformed value must fail the boot loudly, not silently become `NaN` and
reject every upload.

**The server is the authority.** The route schema enforces it, and a request carrying more images is
a 400 in Bahasa.

The web cannot see an API-side env var: it is a static build served by nginx. So `GET /users/limits`
exists, and the app fetches it once at boot.

**If that fetch fails, the composer falls back to a built-in default and stays usable.** This is the
failure mode that made the shared-constant alternative attractive, and it is closed by making the
web's copy advisory rather than authoritative: the fallback can only be wrong about how many photos
the button lets you attach, and the server still has the final say with a Bahasa error. A composer
that refuses to open because a config endpoint is down would be a worse product than one that
occasionally offers a sixth photo and is told no.

## 7. The composer

An optional media strip above the text box. "Tambah foto" opens the file picker; each chosen file
uploads immediately, showing a local preview and progress. Each pending image can be removed before
the post is sent.

- The button disables at the limit.
- **Kirim stays disabled while any upload is still in flight** — the post cannot reference an id that
  does not exist yet.
- A failed upload marks that one image, leaves the text alone, and offers a retry.

**The edit composer is the same strip, seeded with the post's existing images.** It loads them as
thumbnails, each removable, and "Tambah foto" adds more up to the limit. Simpan sends the resulting
list, and Batal discards the whole edit — including any image uploaded during it, which is then
unclaimed and swept by §8 like any other abandoned upload.

Per §5.2 there is no drag-to-reorder in this phase.

## 8. Lifecycle

**Orphans.** Someone attaches a photo and abandons the post, and the row keeps `post_id = null`
forever. `apps/worker` sweeps unclaimed media older than 24 hours, deleting the objects and then the
row. The window is generous on purpose: a person may leave a composer open for an hour.

**Removed by an edit.** An image dropped from a post by `PATCH` (§5.2) has its `post_id` set back to
`null` — it is **unclaimed, not deleted**. It then becomes an ordinary orphan and the same sweep
collects it, so removal has exactly one code path whether the person abandoned a composer or edited
an image away.

Two things follow that should not be mistaken for bugs. An image uploaded days ago and removed today
is swept on the next run rather than after a fresh 24 hours, because the window is measured from
`created_at` — correct, since nothing references it any more and no composer is waiting on it. And
**removal is not undoable**: re-editing to bring an image back is not supported, because once swept
the bytes are gone. Undo would need a deleted-at column and a restore path, and is deliberately not
built.

**Deletion.** Post deletion stays soft, and deleting a post **leaves its media rows and its objects
untouched** — nothing is removed from the bucket. The post's row still exists and can still be read
by an admin path, so media that had been deleted out from under it would be worse than media nobody
is currently serving. Reclaiming that storage is a hard-delete sweep, and is **out of scope**.

**Failure between upload and claim.** The bucket write happens before the row is inserted. An
interrupted upload therefore leaves an object with no row — invisible to the app, and not reachable
by any id. This is a known, accepted leak; it is bounded by upload failures rather than by traffic,
and cleaning it needs a bucket-listing sweep that is not worth building until there is evidence it
matters.

## 9. Risks

**The first native dependency.** `sharp` means `deploy.sh` gains an install that can fail on the box
in a way pure TypeScript never has. It must fail loudly at deploy rather than at the first upload.

**HEIC is rejected.** sharp's prebuilt libvips excludes HEIC for licensing reasons, so an iPhone
photo in its native format cannot be decoded. iOS Safari usually converts to JPEG when uploading
through a file input, so this is expected to be rare — but "usually" is not "always", and the person
who hits it gets a clear Bahasa message naming the formats that work, never a generic failure. **If
this turns out to be common in practice, it is the first thing to revisit in this phase.**

**Bandwidth is paid twice** (§5.1). The fix, when it is needed, is a cache in front of the two `GET`
routes — nginx or a CDN — keyed on the media id, for media that is not gated. That is an addition,
not a redesign, which is the point of proxying now.

**EXIF.** Re-encoding strips it, which is not only a size win: phone photos carry GPS coordinates,
and publishing one with its metadata publishes where the person was standing. This is a deliberate
privacy behaviour and should be tested as one, not left as a side effect of the resize.

## 10. Validation

- The file's **actual header** decides its type, never the client's `Content-Type`.
- Accepted: JPEG, PNG, WebP. Rejected: everything else, HEIC named specifically in the copy.
- Maximum 10 MB per file, rejected before it is read into memory.
- Full image: max 1600px on the long edge, WebP. Thumbnail: 600px, WebP.
- An image smaller than the target is not upscaled.

## 11. Testing

Alongside the usual unit and route coverage, three things in this phase are only provable in
particular ways:

- **The fake storage adapter is what lets the api suite run with no bucket credentials.** Same
  pattern as `FakeMessagingAdapter`, and the same rule: the real adapter must never be reachable
  from a test.
- **Re-encoding must be asserted on real bytes.** A fixture image with known EXIF, including GPS,
  and an assertion that the stored bytes no longer carry it. A mock cannot prove this.
- **The delivery routes must be proven to proxy**, not redirect: assert a 200 with image bytes and a
  correct content type, and assert explicitly that no `Location` header and no bucket hostname ever
  appears in any response.
- **Editing must be proven not to steal.** A `PATCH` naming media that belongs to another post — and
  specifically to another *person's* post — is refused, while a `PATCH` naming the post's own
  existing images succeeds. Those two live one clause apart in §5.2, so a mutation that widens the
  ownership check has to redden a named test rather than pass quietly.
- **Editing must be proven to unclaim.** Removing an image leaves its row with `post_id = null`
  rather than deleting it, and the sweep is what collects it. Assert the intermediate state, not
  just the absence from the post — a test that only checks the post no longer shows the image passes
  equally well against an implementation that deletes the bytes immediately.

## 12. Honest limitations

- No video. Named in the parent spec as its own project, after images.
- No avatars or profile headers, though the same `MediaStoragePort` will serve them.
- No alt text. It is the cheapest accessibility win available in a later phase and is deliberately
  not smuggled into this one.
- No cropping, rotation or filters.
- Images are editable after posting (§5.2), but not reorderable in this phase and not restorable
  once removed (§8).
- Gating is Phase 6. Everything here is public; the design is what makes gating a change to two
  handlers rather than a rebuild.
