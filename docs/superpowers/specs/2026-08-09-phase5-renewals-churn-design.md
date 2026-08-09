# Phase 5: Renewals & Churn — Design Spec

Date: 2026-08-09
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: Phase 1 (`d0904b8`), Phase 2 (`565d43a`), Phase 3 (`c78ad11`), Phase 4 (`e722276`)

## 1. Purpose

Phase 4 made the product deliver access. **Nothing takes it away.** A member who pays once
keeps their Telegram invite forever, which is precisely the PRD's second validated problem:

> *"Tidak ada cara sistematis untuk menangani member yang berhenti bayar — sering berujung
> member 'numpang' tanpa bayar atau churn tanpa terdeteksi."*

Phase 5 closes that: renewals are tracked, members are reminded, and access is revoked
automatically when they stop paying.

## 2. A second PRD assumption that does not survive contact with the APIs

The PRD specifies *"recurring billing otomatis"* with a day-1/3/7 **charge retry** schedule.
Researched 2026-08-09:

Xendit supports recurring charges via tokenization for **cards, e-wallet linked accounts, and
direct debit**. **QRIS is absent, and necessarily so** — a QRIS payment is a one-time QR scan
that produces no token to charge later. Phase 3 built invoice-based checkout, which stores no
token at all.

So the PRD's own thesis works against it: it centres on QRIS as the default Indonesian payment
method (*"Adopsi QRIS dan e-wallet sudah matang dan menjadi metode pembayaran default"*), and
that is exactly the method that cannot be silently re-charged.

### 2.1 Decision (ruled 2026-08-09)

Phase 5 implements a **renewal lifecycle, not auto-debit**:

- Before the renewal date, the member gets a WhatsApp reminder with a **fresh checkout link**.
- The day-1/3/7 schedule becomes **escalating reminders**, not charge retries.
- Unpaid past the grace deadline → `churned` → **Telegram access revoked automatically**.

This solves the PRD's actual validated pain — systematic handling of non-payers — for **every**
payment method including QRIS. It is a deliberate narrowing, recorded here so it is not
mistaken for an oversight, and it should be reflected back into the PRD.

**Deferred, not rejected:** true auto-debit for members who pay by card or opt into e-wallet
account linking. That needs a second checkout flow and a token store, and belongs in its own
phase once the Xendit adapter has been verified against a real sandbox.

## 3. Scope

**In scope:**
- `subscription.status` gains **`past_due`** between `active` and `churned`
- `subscription.grace_ends_at`
- New `renewal_reminder` table, unique on `(subscription_id, stage)`
- Two scheduled worker passes: `ProcessRenewals` and `ProcessChurn`
- Reminder delivery through the **existing Phase 4 outbox**
- `RevokeChannelAccessForSystem` — a system-initiated revoke with no creator scoping (§5)
- Renewal payment: paying a reminder link extends the subscription rather than duplicating it
- `activity_log` entries for every state change, which Phase 6's analytics will read

**Out of scope (with the phase that owns it):**
- Creator-facing churn analytics — **Phase 6**
- True tokenized auto-debit — its own later phase (§2.1)
- Refunds, proration, plan changes
- Creator-configurable grace periods (no dashboard exists to set them)

## 4. Time is the adversary

Every prior phase was triggered by an HTTP request. This one is triggered by a **clock**, and
that changes what can go wrong:

- **A job that runs twice** must not send two reminders or revoke twice.
- **A job that did not run for two days** must not fire five reminders at once, nor skip the
  grace period.
- **A job that runs at 00:30 Asia/Jakarta** must not treat it as the previous UTC day and
  revoke someone a day early. Phase 3 deferred this exact drift on `next_billing_date`; here it
  decides whether a paying member loses access.

Therefore, as hard requirements:

1. **Time is injected**, never read from `Date.now()` inside a use-case. Tests set the clock.
2. **Reminder idempotency is arbitrated by the database** — `renewal_reminder` unique on
   `(subscription_id, stage)`. Phase 4's credential leak came from an idempotency claim that
   was true of our table but not of the world; here the claim must be true of the *member's
   inbox*.
3. **A missed window is caught up, not replayed.** If the job has not run since before several
   stages elapsed, the member receives the **most advanced** applicable reminder once — not one
   per skipped stage. There is an explicit test for a job that was down for three days.
4. **The grace deadline is stored, not recomputed.** `grace_ends_at` is written when the
   subscription enters `past_due`, so a later timezone or config change cannot retroactively
   move someone's deadline.
5. All renewal timestamps are interpreted in **Asia/Jakarta**, the market's timezone, and the
   conversion happens in one documented place.

## 5. The trust boundary, made explicit

`RevokeChannelAccess` (Phase 4) requires a `creatorId` for its 404 scoping. Churn detection
starts from a subscription and has no creator in hand.

Phase 5 adds a **separate system-initiated entry point**, `RevokeChannelAccessForSystem`,
taking only the subscription. It performs no creator-scoping check **because there is no
untrusted caller to authorize** — the churn job *is* the system.

The rejected alternative was to have the worker resolve subscription → tier → community →
creator and call the existing path. That would satisfy an authorization check with data the
worker looked up itself: authorization theatre, and worse, it would make a future reader
believe a real check was happening. Two entry points with two honest trust models is the
correct shape.

Both share the same underlying provider-removal and audit logic.

## 6. The renewal lifecycle

`ProcessRenewals` (scheduled): finds subscriptions whose `next_billing_date` is within the
reminder window; transitions `active` → `past_due` on the due date, sets `grace_ends_at`, and
enqueues one reminder outbox row per applicable stage:

| Stage | When | Effect |
|---|---|---|
| `pre_3d` | 3 days before due | Reminder; member can renew without ever losing access |
| `due` | on the due date | `active` → `past_due`, `grace_ends_at` set (= due date **+10 days**) |
| `overdue_1d` | +1 day | Escalating reminder |
| `overdue_3d` | +3 days | Escalating reminder |
| `overdue_7d` | +7 days | **Final warning** — three whole days before access is revoked |
| — | **+10 days** | Grace expires: `ProcessChurn` marks `churned` and revokes access |

`ProcessChurn` (scheduled): finds `past_due` subscriptions past `grace_ends_at`, marks them
`churned`, and enqueues a `revoke_access` outbox row → Telegram access removed.

The pre-due reminder exists because the "charge" is now a **manual action the member must
take**. A member who simply forgot should never be removed without warning.

### Why the grace period is 10 days and not 7

The grace period **must exceed the last reminder offset by enough that the final warning is
always claimable well before churn.** It was originally 7 — the same number as `overdue_7d` —
and that made the final warning not a warning:

- `overdue_7d` becomes claimable at **00:00 WIB** on day 7 (stages compare Asia/Jakarta
  calendar days);
- the deadline is `next_billing_date + GRACE_DAYS`, and `next_billing_date` is a Postgres
  `date` that parses as UTC midnight, so it landed at **07:00 WIB on the same day**.

A seven-hour window — and `ProcessRenewals` and `ProcessChurn` run on two independent loops, so
which reached the member first inside it was a race. Phase 5 Task 9 walked the lifecycle twice
in a running worker and **churn won both times**: the member was revoked having received
`overdue_3d` as their last word, which this section and §8 both forbid.

The day-1/3/7 cadence is left exactly as it is — it comes from the PRD, where it described
**charge retries**, something the system does. Reinterpreting it as reminders made it something
the **member** must act on, and a member who must act needs time to act. Three days between the
final warning and losing access is the smallest gap that is unambiguously not a race.
`renewal-schedule.test.ts` pins this as a relationship between the last stage and the deadline,
with a stated minimum gap, so editing either number alone fails.

Changing the grace length never moves a deadline already stored: `grace_ends_at` is written
once, on entering `past_due` (§4.4).

## 7. Renewal payment

A reminder carries a fresh checkout link to the existing public flow.

- Paying while `past_due` → the subscription returns to `active`, `next_billing_date` advances
  by the tier's billing cycle, `grace_ends_at` clears, reminders for that period are done.
  **No new invite is issued** — the member never left the group. Re-inviting would mint a
  second credential, which Phase 4's invariant forbids.
- Paying **after** revocation → a genuinely new grant, which needs `unbanChatMember` before the
  invite. Phase 4 built that path; this is its first real use.
- Phase 3's "already has an active subscription for this tier → 409" must **not** block a
  `past_due` member from renewing. This is the interaction most likely to be got wrong.

## 8. Errors and edge cases

| Condition | Behaviour |
|---|---|
| Job runs twice in one window | Second run sends nothing (unique `(subscription_id, stage)`) |
| Job down for 3 days | Most advanced applicable reminder only, once |
| Member pays on day 5, before revocation | Back to `active`, no new invite |
| Member pays after revocation | New grant, `unbanChatMember` first |
| Notify provider fails | Outbox retries (Phase 4's bounded retries) |
| Revoke provider fails | Outbox retries; membership still marked revoked |
| Community archived mid-cycle | No reminders, no revoke; recorded in `activity_log` |
| Tier deleted or deactivated mid-cycle | Reminder still sent using the recorded amount |

## 8b. What this phase leaves in `activity_log` — Phase 6's input contract

`activity_log` is Phase 6's declared source for analytics, and this phase is the first to
write to it from a clock rather than from a request. Everything below is a string Phase 6
will have to `group by`, so it is written down here rather than only in the code that emits
it.

| `event_type` | Written by | Means |
|---|---|---|
| `renewal_reminder_queued` | `ProcessRenewals` | A stage was CLAIMED and an outbox row written. **Not a delivery.** |
| `renewal_reminder_sent` | `SendRenewalReminder` | The WhatsApp message actually reached the provider. **This is the one that means "delivered".** |
| `renewal_reminder_skipped` | `ProcessRenewals` | Deliberately not queued — the community does not accept renewals (archived). |
| `renewal_reminder_not_sent` | `SendRenewalReminder` | Claimed, then deliberately not delivered: the subscription or the community stopped qualifying while the row waited. |
| `churned` | `ProcessChurn` | `past_due` → `churned`. Carries the `graceEndsAt` the member was actually measured against. |
| `churn_revoke_skipped` | `ProcessChurn` | Churned but NOT evicted — the community is archived (§8). |
| `access_not_revoked` | `RevokeChannelAccessForSystem` | A queued revocation that no longer applied: the member is entitled again. |
| `renewed` | `HandlePaymentWebhook` | A payment that EXTENDED a membership. |

Three things a query has to know, all of which have already been got wrong once:

1. **One reminder produces two rows**, `renewal_reminder_queued` then
   `renewal_reminder_sent`. Counting "reminders" without filtering by `event_type` doubles
   every figure. The queued row is written even when the send later fails; only the sent row
   says a member was told.
2. **`renewed` is not `joined`.** A renewal is the same member paying again, and this phase
   is the first to produce one. Counting `joined` rows as new members is correct only
   because renewals are recorded separately — collapsing them would inflate acquisition for
   ever and make retention invisible. The distinction can only be made inside `markPaid`,
   which is the one place that sees the status the row was in before activation.
3. **`renewal_reminder` rows are DELETED on renewal.** That table is a LOCK — the unique
   `(subscription_id, stage)` is what makes a reminder once-per-stage — and not a history:
   `markPaid` clears a subscription's rows when the period they belong to ends, so the next
   period's stages are claimable again. "How many reminders went out last month" must
   therefore come from `activity_log`, never from `renewal_reminder`.

## 9. Testing

- **Every time-dependent test injects the clock.** No `setTimeout`, no real waiting.
- Idempotency proven by **running each job twice** and asserting counts — reminders sent,
  `activity_log` rows, outbox rows — not just final state. Phase 4 shipped a leak past a test
  that asserted final state only.
- The **missed-window** case has its own test: job down three days, exactly one reminder.
- The **pay-before-revocation** case asserts **no second invite link** is minted at the
  provider, counting provider mints rather than database rows (Phase 4's lesson).
- Concurrency: two workers running the same pass must not double-send. Pinned
  **deterministically** — a forced interleaving or an SQL-shape assertion, not a bare
  `Promise.all`, which has now produced a false pass three times in this project.
- Asia/Jakarta boundary: a subscription due at 00:30 local is not treated as due the previous
  day.

## 10. Carry-forward items to address here

From Phase 4's ledger:
- **Test isolation** is per-`DATABASE_URL`; concurrent suites give ~140 spurious failures and a
  running worker steals outbox rows. This phase adds more worker tests and will hit it harder.
  Fix with a per-run schema or database, and add a CONTRIBUTING note (none exists).
- **`ProcessOutbox` concurrency is unbounded per pass** — 2,000-member communities × N channels
  × 15s timeouts will not drain on a serial poll. Renewals multiply the row volume.
- **No creator-facing reissue** for a `mint_lost` membership.
