# Phase 6 gate — manual checklist

Run against `feat/exclusive-content`. **This is the first gate where the thing being tested is whether
something is genuinely unreachable**, and "I couldn't see it" is not the same as "it wasn't sent".

3,600+ automated tests pass. The paywall's two barriers were each proven to hold **with the other
deleted** — a reviewer rewrote the projection to publish every gated media id to every stranger, and
all 47 media route tests still passed. That is a strong result, and it still does not tell you what a
real browser receives.

**Four things reached the end of this phase unproven, and they are why this checklist exists:**

1. **No real browser has ever loaded a gated post.** Every test asserts on a response object, not on
   what a browser fetches, caches, or renders.
2. **No real cache has ever seen these headers.** `private, no-store` is asserted as a string; nginx,
   Cloudflare and the browser's own cache have never been asked to honour it.
3. **The lock has never been looked at.** It is the conversion surface — the whole product, per the
   parent spec — and nobody has seen it next to a real photo.
4. **`/dashboard/*` was proven untouched by diff, never by use.**

> Keep the browser's **Network tab open with "Disable cache" OFF** for most of this. What you are
> checking is partly *what gets cached*, and disabling the cache hides exactly that.

---

## 0. Before you start

```bash
cd apps/api && bun run db:migrate    # adds post.visibility, default 'public'
```

**Confirm the migration was additive**: every post that existed before is still public.

```sql
SELECT visibility, count(*) FROM post GROUP BY visibility;
```

Everything should be `public`. A single `members` row here would mean the migration locked something
its author published openly.

---

## 1. Compose a members-only post

- [ ] Open the composer with **no image attached**. **"Khusus anggota" is disabled**, and the hint
      reads *Tambahkan foto dulu — teks selalu bisa dibaca semua orang.*
- [ ] Attach a photo. The checkbox **enables**.
- [ ] Tick it, then **remove the photo**. The checkbox must **un-tick itself** — not just grey out.
- [ ] Re-attach, tick, and post. The post appears with its caption and its image.

## 2. What a stranger sees — the conversion surface

Open the creator's profile in a **private window** (signed out).

- [ ] The post is **there, in place** — not hidden, not filtered out.
- [ ] The **caption is readable**.
- [ ] The images are replaced by the lock: **`3 foto terkunci`** and **`Jadi anggota untuk melihat`**.
- [ ] **Tap the lock.** It goes to the creator's profile, where *Jadi anggota* and the price already
      live.
- [ ] **Now the real test.** Open the Network tab, reload, and search the requests for
      `/users/media/`. **There must be no request that returns image bytes for that post.** Not a 403,
      not a 404 — ideally no request at all, because the id was never sent.
- [ ] Search the page source (`Ctrl+U` or `document.body.innerHTML`) for `/users/media/`. The gated
      post's ids must not appear anywhere in the DOM.

## 3. The forwarded link — barrier two on its own

This is the case barrier one cannot help with: **a paying member has legitimate ids and can pass one
on.**

- [ ] Sign in as a **member** of that creator, open the post, and copy a media URL from the Network
      tab — it looks like `/users/media/<uuid>`.
- [ ] Paste it into a **private window** (signed out). **404.**
- [ ] Append `/thumb` to the same URL and repeat. **404.** Both handlers are gated separately, and the
      thumbnail is the one the feed actually renders — a gate on one and not the other would leak
      every image in the feed while the full-size view looked secure.
- [ ] Sign in as a **different user who is not a member** and open both URLs. **404** again.

## 4. Buying, and lapsing

- [ ] As a signed-in non-member, buy the membership (Xendit **test mode**). After payment, the same
      post's **images appear** — no lock, no reload trick.
- [ ] Now end the period by hand:

```sql
UPDATE user_subscription
   SET current_period_end = now() - interval '1 minute'
 WHERE subscriber_id = '<the buyer uuid>' AND status = 'active';
```

- [ ] Reload. **The images lock again immediately.** No grace, by design.
- [ ] Re-open the forwarded media URL from §3 as that lapsed member. **404.**

This step is where Phase 5b's retirement work becomes visible: a status-only check would still call
this person a member.

## 5. The author's own view, and mixed pages

- [ ] Signed in **as the creator**, your own members-only post shows **your images**, never a lock.
- [ ] Post a **public** photo from the same account. Signed out, a stranger sees the **public post's
      images** and the **gated post's lock** on the same page.

That second check is not decoration. The gate is computed per page from a set of author ids, and an
early version of this design would have withheld the public post's images too, because its author
appeared in the set for a different post.

## 6. Caching — what no status code can catch

With the Network tab open and **caching enabled**:

- [ ] A **gated** image (as a member) → `Cache-Control: private, no-store`.
- [ ] A **public** image → `Cache-Control: public, max-age=31536000, immutable`.

If a gated response ever says `public`, stop and tell me. A shared cache — nginx, a CDN, a corporate
proxy — would then hold that image and hand it to strangers, and **no test of the response's status
code would ever catch it.**

## 7. Editing — the direction that silently un-gates

- [ ] Edit a members-only post's **caption only**, without touching *Khusus anggota*. Save. Reload
      signed-out: **it must still be locked.**

An omitted `visibility` on an edit means *leave it alone*. If it ever meant *make it public*, every
edit anyone makes would quietly un-gate the post, and nothing on the happy path would look wrong.

- [ ] Edit the post and **remove its last image** while it is still members-only. The server must
      **refuse** — a lock with nothing behind it protects nothing.
- [ ] Untick *Khusus anggota* **and** clear the images in the **same** edit. This must **work**;
      otherwise fixing one mistake takes two edits.

## 8. `/dashboard/*` is unchanged

- [ ] Log into the old dashboard and confirm its members, tiers and transactions behave exactly as
      before. It was proven untouched by diff across every commit in this branch; this is the check
      that it is also untouched in practice.

---

## Still outstanding from earlier phases

- [ ] `client_max_body_size 12m;` in nginx on the VPS — **not in the repo**. Without it every real
      photo upload 413s.
- [ ] **Rotate the Biznet access key and secret** that appeared in the screenshot.
- [ ] The Phase 4, 5a and 5b gate checklists, if you have not finished them.
