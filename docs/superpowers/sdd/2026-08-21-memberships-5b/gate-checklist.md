# Phase 5b gate — manual checklist

Run against `feat/memberships-5b`. **This phase is about time passing**, and that is exactly what an
automated suite cannot wait for.

2,506 api tests, 832 web tests, 83 worker tests and 85 shared tests pass. Every window in this phase
was tested at its boundary in both directions, and every concurrency guard was watched to fail with
its protection removed. **None of that proves the worker is actually running on your VPS**, and none
of it has sent a real email or a real WhatsApp message.

**Five things reached the end of this phase unproven, and they are why this checklist exists:**

1. **The three new passes have never run on a real schedule.** They were tested by calling them; the
   worker's hourly loop is what makes them happen without you.
2. **No reminder has ever been delivered.** Email and WhatsApp both ran against fakes, by design.
3. **The 2-hour stale-checkout window is a guess about Xendit.** It must be longer than a person's
   checkout and shorter than an invoice's real life. Xendit documents 24 hours; nobody has watched a
   real invoice die.
4. **The renewal loop has never been walked end to end with real money** — buy, lapse, buy again.
5. **The subscriber list has never been looked at.** It is the phase's only screen.

> Xendit **TEST MODE** for everything involving money, exactly as in the 5a gate.

---

## 0. Before you start

```bash
cd apps/api  && bun run db:migrate     # 0029_open_proudstar, 0030_early_puma
cd ../worker && bun run dev
```

**Read the worker's boot log.** You are looking for the passes to be registered at all:

```
[worker] renewal interval: 3600000ms
```

Nothing in this phase logs on an empty pass — silence means "no rows", not "not running". If you want
to see the passes speak on demand, set a short interval for the session:

```bash
WORKER_RENEWAL_INTERVAL_MS=60000 bun run dev
```

**Keep a psql open.** Most of this checklist is time travel:

```bash
psql "$DATABASE_URL"
```

---

## 1. The subscriber list (Task 6)

The only new screen. **Pengaturan**, not the public profile — deliberately: it is owner-only, and
Pengaturan is where the parent spec puts everything about managing your own memberships.

- [ ] Sign in as a creator who has at least one active subscriber. The list shows **handle, display
      name, and "Sejak …"** — and nothing else.
- [ ] Confirm no email address and no WhatsApp number appears anywhere on the card.
- [ ] Sign in as a **different** user. You see **your own** subscribers, never theirs. There is no URL
      that names somebody else's list — that is by construction, so there is nothing to type.
- [ ] A creator with no subscribers yet sees the empty state, not a broken card.

## 2. The renewal loop — the headline (Tasks 1, 2)

**This is what 5a could not do.** In 5a a member's subscription lapsed and they could never buy again.

- [ ] Buy a membership as a signed-in user (test mode). Confirm active.
- [ ] Now end their period by hand:

```sql
UPDATE user_subscription
   SET current_period_end = now() - interval '1 minute'
 WHERE subscriber_id = '<the buyer uuid>' AND status = 'active';
```

- [ ] Reload the creator's profile. **Access is gone immediately** — no grace, by design.
- [ ] The offer is still there, with **"Keanggotaan Anda di @… sudah berakhir. Pilih paket di bawah
      untuk memperpanjang."** above it. It must NOT say *"Perpanjangan belum tersedia"* — that is 5a's
      dead end, and a screen showing it is the C-1 defect back (the final whole-branch review found
      the profile hiding the button for exactly the window this task exists to serve).
- [ ] Press **Jadi anggota** again. It must offer you the tier and **let you buy**. In 5a this is
      where you were refused and stuck.
- [ ] Do this with the **worker stopped**. It must still work — that is the whole point of the
      retirement being inside the purchase transaction.
- [ ] After paying, confirm exactly **one** active row, and the old one now reads `expired`:

```sql
SELECT status, current_period_end FROM user_subscription
 WHERE subscriber_id = '<uuid>' ORDER BY created_at;
```

The retirement happens **inside the purchase transaction** — you should not have to wait for any
worker pass for this step.

## 3. The sweep (Task 3)

For a member who lapses and never comes back.

- [ ] Expire a row as in §2, then **do not buy anything**. Wait for a pass (or restart the worker with
      `WORKER_RENEWAL_INTERVAL_MS=60000`).
- [ ] Watch for:

```
[memberships] considered=1 retired=1 skipped=0 failed=0
```

- [ ] Confirm the row now reads `expired`. **`failed` must be 0** — a non-zero `failed` means the sweep
      found rows and could not act on them, which is the shape of a real problem.

## 4. Reminders (Task 4) — the one that touches real people

A member is reminded **3 days** before their period ends: email always, WhatsApp too when they have a
number.

- [ ] Put a member exactly inside the window:

```sql
UPDATE user_subscription
   SET current_period_end = now() + interval '2 days'
 WHERE id = '<subscription uuid>';
```

- [ ] Wait for a pass. Expect:

```
[membership-reminders] considered=1 reminded=1 already_reminded=0 skipped=0 failed=0
```

- [ ] **Check the actual inbox.** This is the step no test can do.
- [ ] If that member has a WhatsApp number, check the phone too.
- [ ] Run the pass **again** without changing anything. It must report `already_reminded=1` and
      `reminded=0`. **Nobody may be reminded twice.**
- [ ] Now the case that matters most: a member whose reminder can reach **nobody**. Boot the worker
      with messaging disabled and re-run against a fresh member:

```
[membership-reminders] considered=1 reminded=0 already_reminded=0 skipped=1 failed=0
```

`skipped=1` is the point. A member who could not be told **must** show up in that count — silence here
is the failure this whole design exists to prevent.

- [ ] Then restore the credentials and confirm that same member **is** reminded on the next pass. A
      skip caused by a misconfigured box must be retryable; only a genuine send is permanent.

## 5. Abandoned checkout (Task 5) — the money one

5a's most likely real-world loss: a buyer who walks away is handed the same dead invoice forever.

- [ ] Press **Jadi anggota**, reach the Xendit page, and **close it without paying**.
- [ ] Press it again immediately. You should get **the same invoice** back — you may still be
      mid-payment, and the window (2 hours) exists to protect exactly that.
- [ ] Now age the row past the window:

```sql
UPDATE user_subscription
   SET created_at = now() - interval '3 hours'
 WHERE status = 'pending' AND subscriber_id = '<uuid>';
```

- [ ] Wait for a pass:

```
[pending-checkouts] considered=1 expired=1 skipped=0 failed=0
```

- [ ] Press **Jadi anggota** again. You must get a **brand-new invoice URL**, not the old one.

**The judgement call to confirm:** open a real test-mode invoice and leave it. **Does Xendit still
accept payment on it after 2 hours?** If a real invoice dies sooner than that, the window is too long
and the dead-page case reopens inside it — tell me and I will shorten it.

## 6. What is deliberately NOT here

- **Cancellation.** There is no recurring charge in this system, so nothing will ever bill a member
  again and there is nothing to cancel. A cancel button could only take away access somebody already
  paid for.
- **The join-request WhatsApp fix (§9).** Built, reviewed, and **reverted** — see §9.1 of the spec. It
  could only be joined on an unverified email, which would have let anyone knowing a creator's
  dashboard address receive that creator's join requests. Join requests are still recorded and visible
  in the dashboard; they are just never messaged, which is what was already true.
- **`/dashboard/*`** is untouched, as in every phase since the pivot began. If anything there behaves
  differently, that is a bug in this branch — tell me.

## 7. Still outstanding from earlier phases

- [ ] `client_max_body_size 12m;` in nginx on the VPS — **not in the repo**. Without it every real
      photo upload 413s.
- [ ] **Rotate the Biznet access key and secret** that appeared in the screenshot. Still not done as
      far as I know.
- [ ] The Phase 4 and Phase 5a gate checklists, if you have not finished them.
