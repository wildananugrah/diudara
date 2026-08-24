# Phase 8 gate — manual checklist

Run against `feat/retire-telegram`. **This is the only phase that ships by removing things**, and that
inverts what a gate is for: the suite cannot prove the absence of a thing it no longer tests.

The api suite went from **2,820 tests to 1,598** — and that fall is *not* a signal. Every task
reconciled its own drop file by file, so we know nothing vanished unaccounted for. What we do **not**
know is what a real deployment does with three layers no test here can reach: **nginx**, **the deployed
box's existing config**, and **a running worker**.

**Five things reached the end of this phase unproven:**

1. **The deployed box still has three nginx location blocks this branch deleted.** They are pasted into
   its live config and are **not** inert there.
2. **No worker has started** with the six surviving passes and none of the deleted ones.
3. **Nothing in the repository can catch a missing loop in `main.ts`** — proven, see §4.
4. **The old creator login is gone.** Anyone who had one cannot sign in, by design.
5. **The database still holds every old-world table.** Deliberately: this phase deleted code only.

> **Run this against a staging box first if you have one.** Unlike previous gates, several steps here
> change the deployed configuration rather than just observing it.

---

## 0. Before you deploy

```bash
cd apps/api && bun run db:migrate     # expect: nothing to apply
cd apps/api && bun run db:generate    # expect: "No schema changes, nothing to migrate"
```

**Both must be no-ops.** `db:generate` printing a migration would mean `schema.ts` and the database
have drifted — and since this phase deliberately kept every table while deleting the code that reads
them, a generated migration here would be **the drops we chose to defer, about to happen by accident.**

- [ ] Confirm the old tables are still present and still hold their rows:

```sql
SELECT 'creator', count(*) FROM creator
UNION ALL SELECT 'community', count(*) FROM community
UNION ALL SELECT 'subscription', count(*) FROM subscription;
```

Nothing should be zero that was not zero before. **This is the rollback surface** — it is what makes
this branch reversible.

## 1. The nginx blocks — a removal, not a check

The template lost `^~ /live/`, `^~ /whip/` and `= /_internal/mediamtx-auth-request`. **The deployed box
still has them**, and re-rendering the template is what removes them.

```bash
envsubst < infra/nginx/live-hls.conf.template > /etc/nginx/snippets/live-hls.conf
grep -c '^location' /etc/nginx/snippets/live-hls.conf    # expect: 4
nginx -t && systemctl reload nginx
```

- [ ] `grep -c` returns **4**, not 7.
- [ ] `nginx -t` passes. **Nobody here could run it** — the config is unverified by anything but reading.

**If `nginx -t` fails, stop and tell me.** Everything else in this phase is reversible by a revert; a
broken nginx config is the one step that takes the site down while you are standing there.

## 2. Streaming still works, on the one namespace left

- [ ] Go live from a phone (`/siaran` → **Mulai siaran**) and watch it play.
- [ ] Publish from OBS with the RTMP URL and key.
- [ ] A gated stream shows the lock to a signed-out visitor, and **no `.m3u8` request returns 200** in
      the network tab.

**`live/` is no longer a namespace.** If a real publish fails, the likely cause is the `/whip/` block
you just removed — check whether MediaMTX is still being told to use it.

## 3. The four flows, against a real deployment

The smoke tests prove these against a real database; they have never run against a real *box*.

- [ ] Compose a members-only post; confirm a member sees the photos and a stranger sees the lock.
- [ ] Buy a membership in Xendit **test mode**; confirm the webhook activates it, and that **replaying
      the same webhook changes nothing**.
- [ ] Go live, watch as a member, end the stream.
- [ ] Sign up and log in as a **new** user — the new world's auth is the only auth now.

## 4. The worker — the gap nothing in the repo can see

`main.ts` composes six passes and runs them in one `Promise.all`. **Deleting one of those `.run()`
calls leaves every test in the repository green** — the smoke file, the worker suite, and typecheck.
That was proven, not guessed.

So this is the only place it can be checked:

- [ ] Start the worker and read its startup log. **Six** passes should be named:
      `outbox`, `membershipReminder`, `membershipSweep`, `stalePendingSweep`, `orphanSweep`,
      `userStreamSweep`.
- [ ] Confirm **none** of the deleted ones appear: no `renewals`, no `churn`.
- [ ] Leave it running for one interval and confirm it neither throws nor logs a handler error.

**`processOutbox` is expected to drain nothing.** Its writer is gone; it stays so that any row an older
deploy left behind fails *loudly* rather than sitting silent. It retires with the `outbox` table in the
follow-up.

## 5. What is deliberately gone

- [ ] `/dashboard` no longer exists. It should 404, not error.
- [ ] The landing page's **Mulai sekarang** buttons go to `/signup` — they pointed at the deleted
      dashboard login until this phase caught it.
- [ ] **An old creator cannot log in.** `/auth` is gone, and `creator` rows were not migrated (spec §9).
      Two such rows exist in dev; if any exist in production, this is the step where that matters.

## 6. Two things to watch afterwards

Neither is a defect today. Both are shapes that could become one.

- **Two implementations of the same membership question.** `is-member-of.ts` answers for the profile and
  the watch token; `listActiveOwnersAmong` answers for both post-paywall barriers. **They can drift** —
  break one and a lapsed member is admitted to gated posts while still refused a watch token, or exactly
  the reverse, with neither side able to see the other. One test file now exercises both in one run.
- **The landing page still markets "akses Telegram"**, including a whole feature card, and no task owned
  that copy. It links to nothing deleted, so it is not broken — it is just describing a product that no
  longer exists.

---

## Still outstanding from earlier phases

- [ ] **Rotate the Biznet access key and secret** that appeared in the screenshot.
- [ ] `client_max_body_size 12m;` in nginx — without it every real photo upload 413s.
- [ ] The Phase 4, 5a, 5b, 6 and 7 gate checklists. **Phases 5a and 7 gate this branch's merge**, per
      the sequencing decision taken when this phase was designed: the old world is the fallback, and it
      does not come out until the new one has been seen working on real hardware.
