# Phase 7 gate — manual checklist

Run against `feat/siaran`. **More of this phase is untestable from the repo than any phase before it.**

Around 3,700 automated tests pass. But three whole layers of this feature have never run: **nginx**,
**MediaMTX**, and **a real browser's video engine**. Every test here asserts on a response object or a
happy-dom element. Nothing in the suite has ever moved a video frame.

**Six things reached the end of this phase unproven:**

1. **The nginx template has never served a request.** It renders and `nginx -t` passes — that is
   syntax, not behaviour. No port was ever bound.
2. **MediaMTX has never seen a `u/` path.** The whole namespace is new.
3. **No browser has ever published or played a user stream.**
4. **iOS Safari's native HLS path is completely unverified** — and it is the only path every iPhone
   visitor reaches.
5. **The sweep has never run against a real lost webhook.**
6. **The mint traffic has never been measured** under more than one viewer.

> Use **Xendit test mode** for the membership you buy in §5.

---

## 0. Before you start

```bash
cd apps/api && bun run db:migrate     # adds user_stream + two indexes
```

Render the nginx template into your real config and reload:

```bash
envsubst < infra/nginx/live-hls.conf.template > /etc/nginx/snippets/live-hls.conf
nginx -t && systemctl reload nginx
```

**Confirm both worlds answer before you change anything else.** The old community streaming must still
work exactly as it did — it is the thing most at risk from this branch, and §8 checks it properly.

---

## 1. Publishing — from a phone, then from OBS

- [ ] On **a phone**, open `/siaran`, type a title, and press **Mulai siaran**. Grant camera and mic.
- [ ] The stream appears in the list, and the video plays back.
- [ ] Open the **Pakai OBS** block. Copy the RTMP URL and the stream key into OBS on a desktop, and
      confirm a publish from there works too.

**If the phone publish fails but OBS works**, the `/whip/` nginx location did not learn its namespace —
it used to hard-rewrite onto `/live/<key>/whip`. That is the single most likely thing to be wrong.

## 2. The two nginx directives that were never exercised

The auth locations clear the *other* world's id header, because `auth_request` subrequests inherit
client headers. This was found in review and fixed blind.

- [ ] `curl` a `/live/` HLS URL with a **forged** `X-Mtx-Stream-Id: <anything>` header. It must play
      normally — the directive strips it.
- [ ] `curl` a `/u/` HLS URL with a **forged** `X-Mtx-Event-Id: <anything>`. Same: must play normally.
- [ ] `curl` the auth endpoint directly, without the shared secret. **401.**

If either of the first two 403s, the `proxy_set_header … "";` line for that location is missing or
misspelled — and **both worlds' HLS goes down**, not just one.

## 3. The gate — a stranger, a member, and a forwarded link

- [ ] Go live with **Khusus anggota** ticked. Signed out in a private window, `/siaran` shows the title
      and the lock — and the **Network tab shows no `.m3u8` request that returns 200**.
- [ ] Buy a membership (test mode) and confirm the video plays.
- [ ] Copy the playing `.m3u8` URL **including its `?token=`** and open it in a **private window**. It
      plays — for up to ten minutes. **This is by design and you should see it**: the token is a bearer
      credential, and ten minutes is the bargain we chose.
- [ ] Wait past ten minutes and reload that copied URL. **It must now fail.** The stranger cannot renew
      — re-minting needs the member's session.

## 4. Watching past minute ten — the re-mint

This is where a bug would look like "the video randomly stopped".

- [ ] On **desktop or Android** (hls.js), watch a gated stream for **fifteen minutes**. It must not
      stop, stall, or show the lock.
- [ ] On **an iPhone**, do the same. **Watch for a visible reload roughly every eight minutes** — the
      player swaps the video source because native HLS cannot change its token any other way.
      **Tell me whether it is perceptible.** If it is a brief flicker at the live edge, we leave it. If
      it is an obvious stutter, it is worth more work.
- [ ] Still on the iPhone: after a reload, does playback **resume by itself**? iOS autoplay rules are
      the risk, and no test here can reach them.

## 5. A membership that ends mid-stream

- [ ] While a member is watching, end their period:

```sql
UPDATE user_subscription
   SET current_period_end = now() - interval '1 minute'
 WHERE subscriber_id = '<uuid>' AND status = 'active';
```

- [ ] **Within about a minute**, their player must stop and show the lock. The re-mint is refused and
      the player blocks on that tick.

## 6. The stream that never ends

- [ ] Start a stream, then **kill MediaMTX** so the `offline` webhook is never delivered.
- [ ] Confirm the row stays `live` and Siaran shows a ghost — that is the failure being guarded.
- [ ] Confirm the creator **cannot** start a second stream (the one-live index refuses it).
- [ ] Either wait out the 12-hour cap, or age the row and let the sweep run:

```sql
UPDATE user_stream
   SET started_at = now() - interval '13 hours'
 WHERE status = 'live';
```

- [ ] The worker's next pass ends it, and the creator can go live again.

## 7. Load — the one number nobody has measured

Background mint traffic is **60 requests per hour per gated viewer** — one small authenticated request
plus one indexed lookup each.

- [ ] With a handful of viewers on a gated stream, watch the api logs and the database. Ten viewers is
      ten per minute; a hundred is a hundred. **Tell me what it looks like on a real stream**, because
      the number was chosen to make the paywall react within a minute and nobody has watched it under
      load.

## 8. `/dashboard/*` is unchanged

- [ ] Schedule and run a **community** stream through the old dashboard, end to end: publish, watch,
      end. It was proven untouched by diff across every commit; this is the check that it is also
      untouched in practice — and this branch changed the file that authorises **every** publish and
      **every** read for both worlds.

---

## Still outstanding from earlier phases

- [ ] `client_max_body_size 12m;` in nginx on the VPS — without it every real photo upload 413s.
- [ ] **Rotate the Biznet access key and secret** that appeared in the screenshot.
- [ ] The Phase 4, 5a, 5b and 6 gate checklists, if you have not finished them.
