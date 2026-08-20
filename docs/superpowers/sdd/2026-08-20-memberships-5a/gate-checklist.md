# Phase 5a gate — manual checklist

Run against `feat/memberships`. **This is the first gate in this project where a mistake costs money.**

Everything below is automated-test-proof already: 2,395 api tests and 814 web tests pass, every
database constraint has been shown to reject what it forbids, and the concurrency guards have been
watched to fail with their protections removed. None of that touches Xendit.

**Four things reached the end of this phase unproven, and they are the reason this checklist exists:**

1. **No code in this phase has ever spoken to Xendit.** Payout onboarding, invoice creation and the
   webhook were built against a fake adapter, by design — the api suite runs with no credentials.
2. **KYC is a third party's decision.** A Xendit MANAGED sub-account is a real identity check, and
   nothing here can predict how yours behaves.
3. **`customer.mobile_number` is now omitted when a buyer has no WhatsApp number.** A review
   established that sending `""` was wrong; whether *omitting* it is accepted is unknowable from here.
4. **The community checkout still shares this webhook.** It was proven untouched by reading and by
   mutation — but never by taking a real community payment after the change.

> **Use Xendit's TEST MODE for everything below** until step 8 says otherwise. A managed sub-account
> is a KYC entity with **no delete endpoint** — every one you create in live mode is permanent.

---

## 0. Before you start

`apps/api/.env` needs the Xendit keys you already use for the dashboard: `XENDIT_SECRET_KEY`,
`XENDIT_SPLIT_RULE_ID`, `XENDIT_CALLBACK_TOKEN`.

```bash
cd apps/api
NODE_ENV=development TELEGRAM_BOT_TOKEN= FONNTE_API_TOKEN= bun run dev
```

**Read the boot log before doing anything.** You want a real payments provider and fake messaging:

```
[bootstrap] payments provider: XenditPaymentAdapter …
[bootstrap] messaging providers: FakeMessagingAdapter (gating) + FakeMessagingAdapter (notification)
```

If messaging names **Telegram** or **Fonnte**, stop — those are live credentials and this checklist
signs up accounts.

Web, second terminal:

```bash
cd apps/web
bun run vite --config vite.gate.config.ts
```

`vite.gate.config.ts` is untracked and exists only on your machine — it points the proxy at port 3004.

Create two accounts: **a creator** (`uji_kreator`) and **a buyer** (`uji_pembeli`). Give the buyer a
WhatsApp number. **Leave a third account, `uji_tanpa_wa`, with no WhatsApp number** — step 4 needs it.

---

## 1. Payout onboarding — **UNPROVEN**, and the only irreversible step

As `uji_kreator`, open Pengaturan → the membership section → connect a payout account.

- ✅ It reports a state. **Three are possible** and the UI distinguishes all three: not connected,
  **waiting on verification**, connected.
- ❌ A 500, or a failure naming credentials — this is the adapter's first real call.

**If it lands in "waiting", that is not a bug.** It is Xendit verifying an identity, and it is the one
thing in this phase whose timing nobody here controls.

Then, while it is waiting:

- ✅ **The tier editor stays shut**, with a Bahasa explanation.
- ❌ The editor opens — the mid-provisioning state is being read as connected, which is the exact bug
  three separate tasks were written to prevent.

**Press connect twice, quickly.** ✅ You get one account, not two. (Measured in tests: 30 concurrent
attempts produce exactly one. The failure mode this prevents once created 30 sub-accounts and orphaned
29, permanently.)

## 2. Defining what you sell

Once genuinely connected:

- Create a tier — a name and a price in rupiah.
- ✅ It appears in your list.
- ✅ **There is no "edit".** Deliberate: the server has no rename and no reprice. To change a tier you
  withdraw it and create another. Existing members keep the price they agreed to.
- Withdraw a tier. ✅ It stops being offered and existing subscriptions are untouched.

## 3. The offer, as a stranger sees it

Open `/@uji_kreator` **signed out**.

- ✅ The tiers show, with prices as a person reads rupiah.
- ✅ Pressing **"Jadi anggota"** sends you to **Masuk** — not a failed request.

Open your own profile as `uji_kreator`. ✅ You are never offered your own membership.

## 4. A real payment — **UNPROVEN**, and the point of the phase

Sign in as `uji_pembeli`. Open `/@uji_kreator`, press **Jadi anggota**.

- ✅ You reach a Xendit invoice page for the right amount.
- ❌ A failure creating the invoice — check whether the message mentions the account id. If it contains
  **`provisioning:in-progress`**, that is the sentinel leaking into a live payment request; stop and
  report it.

Pay it in test mode. Then:

- ✅ Back on `/@uji_kreator`, you are shown **as a member**, not offered the button again.
- ✅ Your subscription is `active` in the database with a `current_period_end` in the future.

**Then repeat with `uji_tanpa_wa` — the account with no WhatsApp number.** This is check 3 from the
top of this document.

- ✅ The invoice is created and payable.
- ❌ Xendit rejects it for a missing `mobile_number`. That would mean the field cannot simply be
  omitted, and the honest fix is to ask for a number before checkout rather than send an empty one.

## 5. Double-tapping — the failure that would take money twice

As a fresh buyer, on `/@uji_kreator`, **tap "Jadi anggota" twice quickly** — a real double-tap, not two
deliberate presses a second apart.

- ✅ **One invoice.** You land on the same payment page both times.
- ❌ Two invoices. Two live invoices mean a buyer who pays both is charged twice, and 5a has **no
  refund path**.

Then abandon it — close the page without paying — and press again.

- ✅ You get the **same** invoice back.
- ⚠️ **Known gap:** if that invoice has expired at Xendit (roughly a day), you are handed a dead payment
  page and 5a cannot mint a new one. Note it if you see it; 5b's pending-checkout cleanup is the fix.

## 6. The webhook — **UNPROVEN under redelivery**

In Xendit's dashboard, **redeliver the invoice-paid webhook** for the payment from step 4.

- ✅ Still exactly one active subscription, one paid transaction, and the period is **not** extended a
  second time.
- ❌ A duplicate, or a doubled period — idempotency has only ever been proven against a fake.

## 7. The community checkout still works — **the regression that matters most**

This phase edited `handle-payment-webhook.ts`, which serves the dashboard's money.

Take a **real community payment** through the old flow — `/c/<slug>` — in test mode, and let its
webhook arrive.

- ✅ The subscription activates exactly as before.
- ❌ Anything else. The production diff was proven purely additive (zero deleted lines, the moved body
  byte-identical across 262 lines) and mutation-isolated in both directions — but it has never been
  proven with a real payment, and a silent break here means people pay and get nothing.

## 8. Before you go live

- **Rotate any test keys** and switch to live credentials deliberately.
- **Decide who may connect a payout account.** Right now it is ungated self-service: **any signed-up
  account can create a permanent, undeletable KYC entity**, with no eligibility check and no rate
  limit. That matches the old creator flow — but the creator population was never open, and `app_user`
  is your public signup. This is a product decision, not a bug, and it is the one thing on this list
  that scales badly with success.

---

## Cleanup

**Run these in this order.** `user_transaction.user_subscription_id` is a foreign key with
`ON DELETE no action` (migration `0025`), and every buyer in step 4 has a transaction — so deleting
the subscriptions first fails with `23503` and nothing is cleaned up at all. The transactions go
first. The order was wrong until the final review caught it, and this block was verified end to end
against a migrated database afterwards.

```sql
DELETE FROM user_transaction
WHERE user_subscription_id IN (
  SELECT id FROM user_subscription
  WHERE subscriber_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%')
     OR owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%')
);
DELETE FROM user_subscription
WHERE subscriber_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%')
   OR owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%');
DELETE FROM user_tier WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'uji_%');
DELETE FROM app_user WHERE handle LIKE 'uji_%';
```

Both `subscriber_id` and `owner_id` are matched, not just the buyer: a subscription is a row about
TWO of your test accounts, and one still pointing at a `uji_%` owner would block the last statement
on `user_subscription_owner_id_app_user_id_fk`.

**Xendit sub-accounts created in step 1 cannot be deleted.** That is why step 0 says test mode.

---

## If something fails

Note the **step number**, what you saw, and whether it was test or live mode. Steps **1, 4, 6 and 7**
are the ones testing behaviour that has never run outside a test process — a failure there is expected
information, not a surprise. Steps 2, 3 and 5 are pinned by tests, so a failure there means something
regressed.
