# Phase 4 gate — manual checklist

Run against `feat/images`. **Nothing here is automated; this is the browser half that happy-dom and a
fake storage adapter structurally cannot answer.**

Three things in this phase were verified only by reading and by argument, never against reality. They
are marked **UNPROVEN** below and they are the reason this checklist exists at all:

1. **The S3 adapter has never run against a real bucket.** No credentials exist in the repo, and the
   adapter deliberately refuses to run under `bun test`. Every other part of the upload path is
   tested; the part that actually talks to Biznet Gio is not.
2. **The CSS was written blind.** No implementer could see a rendered page.
3. **The proxy guarantee** — that media arrives as bytes and never as a bucket URL — is pinned by
   header and magic-number assertions against a *fake* adapter. Phase 6's paywall rests on it.

---

## 0. Before you start

**Rotate the Biznet keys from the screenshot** if you have not already. They were shown in a
conversation and should be treated as compromised.

Then put five values in `apps/api/.env`:

```
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET=...
S3_ENDPOINT=...        # Biznet Gio NEO's S3 endpoint
S3_REGION=...
```

**Start the API and read the boot log before doing anything else:**

```bash
cd apps/api
NODE_ENV=development TELEGRAM_BOT_TOKEN= FONNTE_API_TOKEN= bun run dev
```

Two lines matter.

```
[bootstrap] media storage: S3MediaStorageAdapter (bucket <name> at <endpoint>) — uploads are REAL
[bootstrap] messaging providers: FakeMessagingAdapter (gating) + FakeMessagingAdapter (notification)
```

- If the media line says **FakeMediaStorageAdapter**, your five vars are not all set — uploads will
  live in memory and vanish on restart, and every check below will lie to you.
- If the messaging line names **Telegram** or **Fonnte**, stop: those are live credentials and this
  checklist signs up accounts.

**If the API refuses to boot over a missing bucket, that is correct behaviour**, not a bug. It is
deliberate: an API that accepts uploads and silently drops them is worse than one that will not start.

Web, in a second terminal:

```bash
cd apps/web
bun run vite --config vite.gate.config.ts
```

**`vite.gate.config.ts` is UNTRACKED and exists only on the project owner's machine** — it is
the Phase 3 gate's own config, pointing the proxy at port **3004** rather than the documented
default of 3000. Carried forward here because that is still where this box's API listens. On any
other machine, use `bun run dev` and whatever port `apps/api/.env` sets.

Open <http://localhost:5173>, sign in, go to `/beranda`.

---

## 1. The path that has never run — **UNPROVEN**

Attach one photo to a post and send it.

- ✅ The post appears with its image.
- ❌ **A 500, or a failure naming the endpoint or credentials** — the S3 adapter's first contact with
  a real bucket. Everything about it was verified by reading Bun's `S3Client` typings and an offline
  probe. This is the check that has no substitute.

Then, and this is the one that proves the bytes really left the machine:

- **Restart the API** (`Ctrl-C`, `bun run dev` again) and reload the page.
- ✅ The image still loads. It is in your bucket.
- ❌ It 404s — storage fell back to the in-memory fake and you missed the boot line in step 0.

Confirm in the Biznet console that two objects exist under `posts/<media-id>/`: `full.webp` and
`thumb.webp`.

## 2. The proxy guarantee — **UNPROVEN against a real bucket**, and Phase 6 depends on it

DevTools → Network → reload the feed → click the image request.

- ✅ It goes to **`/users/media/...`** and returns **200** with `content-type: image/webp`.
- ❌ **A 302, or any request to a `biznetgio` hostname.** That would mean a bucket URL reached the
  browser — the one thing the parent spec's §5.1 forbids outright, and the reason delivery proxies
  instead of redirecting. A URL outlives the check that issued it.

Also confirm the feed requests **`/thumb`** URLs, not full-size ones. Twenty full images per screen is
brutal on mobile data, and every byte is paid twice — bucket to API, API to browser.

## 3. EXIF and GPS — the privacy behaviour

Take a photo on a phone **with location services on**, upload it, then download the served image
(right-click → save, or `curl localhost:3004/users/media/<id> -o out.webp`).

```bash
exiftool out.webp | grep -i gps    # expect: nothing
```

- ✅ No GPS tags. Re-encoding strips them.
- ❌ Coordinates present — publishing that photo publishes where the person was standing.

This is pinned by a unit test against a fixture carrying real GPS tags, but the fixture was
synthesised. A real phone photo is a different animal.

## 4. HEIC — the known limitation (spec §9)

Upload an **iPhone photo in its native HEIC format** if you can produce one. iOS Safari usually
converts to JPEG on upload, so you may have to work at it — AirDrop to the machine and upload the
`.heic` file directly.

- ✅ Refused with **"Format foto tidak didukung. Gunakan JPG, PNG, atau WebP."**
- ❌ A generic "coba lagi" — that would mean the format branch is not firing, and the person retries
  forever on a cause retrying cannot fix.

**If HEIC turns out to be common in practice, spec §9 names this as the first thing to revisit in the
phase.** Note what actually happened.

## 5. The composer, at 390px

DevTools device toolbar → 390px wide. This is the audience.

| Do this | Expect |
|---|---|
| Type a caption, no photo | Kirim enabled |
| Attach a photo, **delete all the text** | **Kirim DISABLED** — a post is a photo *with* a caption (your decision, spec §7.1) |
| Attach a photo, start typing | Kirim stays disabled **while the upload is in flight** |
| Attach 8 photos at once (limit 5) | 5 attach, and a **Bahasa notice says three were not added** — silence here was a review finding |
| Attach a photo, then a **>10 MB** file | Refused **instantly, before any upload**, naming the limit |
| Kill your network mid-upload | That one image marks as failed with a retry — **your typed caption survives** |

The caption survival is worth checking properly: type a long caption first, then break the upload.
Losing someone's text because a photo failed is the worst outcome this screen can produce.

## 6. Five images on one card

Post with 1, then 3, then 5 images. Look at both **390px** and **1440px**.

- ✅ Nothing overflows the card; the five-image case does not collapse.
- ✅ **The feed does not jump as images load.** Cards reserve their space from the stored width and
  height — if you see the page shift under your thumb while scrolling, that has regressed.

The CSS was written without a browser, and the final whole-branch review then MEASURED it in one:
every image was rendering at the stored full-image height (a five-image post occupied 3,204px of a
390px screen instead of 324), and the obvious one-line fix made a single image reserve zero height
instead. Both are fixed and re-measured. **What to look for now, precisely:** a single portrait
photo should be about 4:3 to 3:4 of the card's width — not a square, and not a full-screen column.
Two or more should be square tiles. And nothing should move when the bytes land.

## 7. Editing

- Edit a post, **remove one image, add another**, save.
- ✅ The card updates and shows **`· diedit`** — an image-only change still marks a post edited.
- ✅ The removed image disappears from the post.
- The removed image's **bytes stay in the bucket** for now, by design. The sweep collects them after
  24 hours; it does not delete inline.

Then confirm the rule that protects other people: you cannot attach media that belongs to another
post. There is no UI path to try this, which is the point — it is enforced server-side.

## 8. Signed out

Sign out and open a profile with photos.

- ✅ Images still load — they are public in this phase; gating is Phase 6.
- ✅ No composer, no Edit, no Hapus.

## 9. The deploy window — **the finding most likely to bite you**

`scripts/deploy.sh` now **reloads the API before it publishes the web bundle** — the final
whole-branch review's fix. The window is still real, but it now pairs a NEW api with an OLD bundle,
which is inert: Zod strips request keys the old client does not send, and the old client never reads
`media`. The dangerous pairing was the other way round, and it was worse than a white screen: a NEW bundle against an OLD api seeds the edit composer with an empty strip, and
saving then sends `mediaIds: []`, **stripping every photo from the post being edited**. That is what
the reorder removes, and it is the shape a ROLLBACK would otherwise reproduce.

`PostCard`'s `?? []` guard stays, and so does this check. **After you deploy, load `/beranda`
immediately** — during the window, not after it.

- ✅ The feed renders, even if some posts briefly show no images.
- ❌ **A white screen.** The guard has regressed, and everyone loading the site mid-deploy sees it.

## 9a. The pixel bomb, and the proxy — **added by the final whole-branch review**

Two refusals that did not exist when this checklist was written. Both are one upload each.

**A tiny file with an enormous picture inside it.** Make one and try to post it:

```bash
cd apps/api
bun -e 'import sharp from "sharp"; \
  const b = await sharp({create:{width:9000,height:5000,channels:3,background:{r:0,g:0,b:0}}}) \
    .png().toBuffer(); await Bun.write("/tmp/bomb.png", b); console.log(b.length, "bytes");'
```

- ✅ It is about **5 KB**, far under the 10 MB cap, and the composer still refuses it with
  **"Resolusi foto terlalu besar (maksimal 40 megapiksel)…"** — not "format tidak didukung", and not
  a spinner that never finishes.
- ❌ If it uploads successfully, the pixel bound has regressed and the API can be OOM-killed on
  demand by anybody with an account.

**A real photo through the real proxy** — this one only means anything on the VPS, not on
localhost, because `vite`'s dev proxy never involves nginx. See CONTRIBUTING.md's
"Pre-deploy checklist: photo uploads (`client_max_body_size`)". Post a 2–5 MB phone photo through
the public origin.

- ✅ It uploads.
- ❌ **"Foto terlalu besar. Pilih foto berukuran di bawah 10 MB."** on a 3 MB photo means nginx is
  still on its 1 MB default and the request never reached the API. Add `client_max_body_size 12m;`
  and reload nginx.

## 10. Nothing else broke

- `/dashboard` still loads (untouched until Phase 8 deletes it).
- Posting without a photo works exactly as before.
- Beranda's two tabs, editing, deleting, and the Phase 3 gate's behaviours all still hold.

---

## Cleanup

**"Media rows go with the account" was FALSE** — final whole-branch review, Minor 8. Migration
`0023` declares both of `post_media`'s foreign keys `ON DELETE no action`, as does `post.author_id`,
so a bare `DELETE FROM app_user` errors on a foreign-key violation and deletes nothing. Delete the
children first, in this order:

```sql
DELETE FROM post_media WHERE owner_id = (SELECT id FROM app_user WHERE handle = 'uji_coba');
DELETE FROM post       WHERE author_id = (SELECT id FROM app_user WHERE handle = 'uji_coba');
DELETE FROM app_user   WHERE handle = 'uji_coba';
```

**Objects in the bucket do not go with any of it** — the sweep only collects *unclaimed* media, and
anything attached to a post stays. Remove test objects from the Biznet console by hand if you care
about the space.

---

## If something fails

Note the **step number**, what you saw, and the browser width. Steps 1, 2, 3, 4, 9 and 9a are the ones
testing behaviour that has never run outside a test process — a failure there is expected information,
not a surprise. Steps 5 through 8 are pinned by tests, so a failure there means something regressed.
