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

The CSS was written without a browser. This step is where it is actually judged.

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

`scripts/deploy.sh` copies the web bundle into nginx **before** it reloads the API. `media` is new on
both sides, so for up to a minute a new bundle can talk to an old API that does not send the field.

A guard now makes that render a post without images rather than a blank page. **After you deploy,
load `/beranda` immediately** — during the window, not after it.

- ✅ The feed renders, even if some posts briefly show no images.
- ❌ **A white screen.** The guard has regressed, and everyone loading the site mid-deploy sees it.

The deeper fix — reloading the API *before* swapping the bundle — is recorded for the whole-branch
review and not done here.

## 10. Nothing else broke

- `/dashboard` still loads (untouched until Phase 8 deletes it).
- Posting without a photo works exactly as before.
- Beranda's two tabs, editing, deleting, and the Phase 3 gate's behaviours all still hold.

---

## Cleanup

```sql
DELETE FROM app_user WHERE handle = 'uji_coba';
```

Media rows go with the account. **Objects in the bucket do not** — the sweep only collects *unclaimed*
media, and anything attached to a deleted post stays. Remove test objects from the Biznet console by
hand if you care about the space.

---

## If something fails

Note the **step number**, what you saw, and the browser width. Steps 1, 2, 3, 4 and 9 are the ones
testing behaviour that has never run outside a test process — a failure there is expected information,
not a surprise. Steps 5 through 8 are pinned by tests, so a failure there means something regressed.
