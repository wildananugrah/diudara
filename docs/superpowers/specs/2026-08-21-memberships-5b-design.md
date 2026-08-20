# Memberships 5b — living with members

Phase 5b of the DIUDARA pivot. Parent specs: `2026-08-17-member-ui-design.md` (§6, §7, §8) and
`2026-08-20-memberships-5a-design.md`, whose §9 records the limitations this phase exists to remove.

**Status: approved in conversation, awaiting written review.**

---

## 1. Purpose

5a can sell a membership. It cannot keep one.

A subscription created in 5a is active for exactly one period, and **nothing renews or expires it**.
Worse, nothing frees the member to buy again: their row stays `status = 'active'`, the partial unique
index still holds their slot, and the purchase guard refuses them. 5a's final fix wave made that
refusal *honest* — it now says the membership ended and renewal is unavailable — but honest is not the
same as fixed.

**This phase makes a membership something a person can keep**, and closes the two money-shaped gaps 5a
recorded.

## 2. The fact that shapes everything here

**There is no recurring charge in this system.** The Xendit adapter has exactly two operations —
`createPaymentAccount` and `createInvoice`. No tokenisation, no card on file. The old community flow
works the same way: `process-renewals` queues a *reminder*, `send-renewal-reminder` delivers it, and
the member pays a fresh invoice by hand.

So **"renewal" here means "buy again"**, and the only thing preventing it is that nothing retires an
expired subscription. That single fact makes this phase smaller than the parent spec's list suggests,
and it is why §5 removes cancellation entirely.

## 3. Decisions taken during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Access after the period ends | **Stops immediately. No grace.** | `isMemberOf` already reads `status = 'active' AND current_period_end > now()`. It is the honest reading of what the member bought, it needs no new column, and **Phase 6's gate stays the single already-reviewed indexed query.** With no auto-charge there is nothing to retry, so grace would simply be free access. |
| Reminder channel | **Email always, plus WhatsApp when a number exists** | Every account has a verified, unique email; `app_user.whatsapp_number` is nullable and signup never requires it. Email reaches everybody, WhatsApp is the channel this audience actually reads — so both, not either. |
| Retiring an expired membership | **Lazily at purchase, plus a worker pass** | See §4. |
| Cancellation | **Removed from scope** | See §5. |

## 4. Retiring an expired membership — the renewal mechanism

A new terminal status, `expired`, joining `pending` / `active` / `cancelled`.

**Nothing about access depends on it.** `isMemberOf` already denies an expired member by date, and
that query does not change. What `expired` does is release the partial unique index
`user_subscription_one_active`, which is the only thing standing between a lapsed member and the
purchase flow that already works.

Two triggers, and both are needed:

**Lazily, at the moment of purchase.** When a buyer presses *Jadi anggota* and their existing row is
`active` but past `current_period_end`, retire it **inside the same transaction as the pending claim**
and continue. A periodic pass alone would leave a member refused for up to an hour after their period
ended — told to buy again by a reminder, and then refused when they try.

**And a worker pass**, because a member who never returns must not sit `active` indefinitely, and
because the reminder pass (§6) runs on the same schedule anyway.

The lazy path is the one a person experiences; the pass is hygiene. **Both must be tested, and the
lazy path must be tested concurrently** — 5a established three times over that a read-then-write
against a unique index needs the database to arbitrate, and this is another one.

## 5. Cancellation is deliberately not built

With no recurring charge, **nothing will ever bill a member again**. There is nothing to cancel.

A cancel button could only end access the member has already paid for, which is strictly worse for
them than doing nothing. If cancellation is wanted later it means *"stop reminding me"*, not *"stop
charging me"* — a preference, not a billing operation, and it belongs with notification settings.

## 6. Reminders

A pass finds memberships approaching `current_period_end` and sends **one** reminder each: email
always, plus WhatsApp when `app_user.whatsapp_number` is set.

Both adapters are optional at boot. **When neither can deliver, the skip is recorded, never silent.**
This is the old world's own discipline and its reasoning transfers exactly — from
`process-renewals.ts`:

> *"the member was never told" is the failure mode of this whole phase, so the one case where it is
> intentional has to be visible in the audit trail.*

A reminder is **claimed before it is sent**, so a pass that runs twice does not remind twice. The
existing renewal-reminder machinery already works this way and is the model to follow.

## 7. Pending-checkout cleanup — the gap that costs real money

5a's final review named this the phase's most likely real-world money loss, and **it needs no failure
at all to reach**: an ordinary abandoned cart, returned to a day later, is handed back the same
now-expired invoice with a dead payment page, permanently.

The pass expires stale `pending` subscriptions, which frees the pending slot so the next attempt mints
a fresh invoice. It also closes the crash-between-claim-and-release case 5a recorded, and the
`attachGatewayReference`-failure orphan its fix wave introduced.

**The window must be longer than a person's checkout**, and shorter than an invoice's life at the
provider. A row younger than that is somebody mid-payment; retiring it would cancel a purchase in
progress.

## 8. The subscriber list

A creator's own profile shows who subscribes to them: handle, display name, and when they joined.

**The projection is closed**, as every projection in this project is: never an email, never a
`whatsapp_number`, never a payout id, never a subscriber's own subscriptions to anyone else. It is
visible **only to the owner** — a subscriber list is not public information.

## 9. `whatsapp_number` reaching notifications

Parent §7: a community owner receives no notification when somebody asks to join, because nothing can
save an owner's own number. `creator.whatsapp_number` exists and is unreachable; the fix belongs on
`app_user`, where Phase 1 already built the field and made it editable.

**This is unrelated to memberships** and shares nothing with them except a cell in the parent spec's
table. It is here because §8 assigned it to Phase 5 and it is small — not because it belongs.

## 10. What Phase 6 gets

**Nothing changes.** `isMemberOf(viewerId, ownerId)` keeps its exact semantics and its single indexed
query. That is the point of choosing no grace: the paywall's question stays the one already written,
reviewed, mutation-tested and pinned against a lapsed subscription.

What changes is that the answer can now be *yes* for longer than one period.

## 11. Testing

Three things here are only provable in particular ways:

- **The lazy retirement must be proven concurrently.** Two simultaneous purchases by a member whose
  row has just expired must produce one pending claim, not two. 5a's `ArrivalLatch` is the tool, and
  its lesson applies: **the contender count is part of the assertion** — four proved far too few
  against a conditional UPDATE, and the number that holds must be measured and recorded beside it.
- **The reminder's skip path must be asserted**, not just its send path. A pass that silently reaches
  nobody is the failure this design is built to make visible.
- **The cleanup window must be tested at its boundary in both directions** — a row just inside it
  survives, a row just outside is retired. A test with only clearly-stale rows passes against a window
  of any length.

## 12. Out of scope

Cancellation (§5), auto-renewal of any kind, refunds, proration, price changes for existing members,
tier renaming (deferred from 5a), multiple concurrent memberships to one creator, anything in
`/dashboard/*`, and any change to `isMemberOf` or the community-scoped tables.
