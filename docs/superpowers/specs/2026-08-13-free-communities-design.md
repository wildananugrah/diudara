# Free Communities and Join Requests — Design Spec

Date: 2026-08-13
Status: Approved for planning
Parent spec: `docs/superpowers/specs/2026-08-07-diudara-mvp-design.md`
Builds on: every merged phase, including browser publishing (`e96fe58`).

## 1. Purpose

DIUDARA cannot take a single member today unless Xendit is fully onboarded: `StartCheckout`
refuses when the creator has no connected account, and `selectPaymentProvider` refuses to boot
at all outside `development`/`test` without keys.

This phase adds the other way in. A community can be **free**, and a member **asks to join**
while the owner **approves**. Payment becomes one of two access modes rather than the only one.

## 2. Configuration: no new variable, because the keys already say it

**There is deliberately no `PAYMENT_GATEWAY_PROVIDER` setting.** It was considered and rejected:
it would have been a second switch describing a fact the environment already states. Whether
Xendit is available is answered by whether `XENDIT_SECRET_KEY` and `XENDIT_SPLIT_RULE_ID` are
set, and whether a given community charges is answered by its owner.

So there is **one** new setting, and it belongs to the creator, not the operator:

**`community.access_mode`** — `paid` or `request`.

This also brings payments in line with how every other optional subsystem in this codebase
behaves. Streaming and the AI co-builder both follow the rule "absent configuration disables the
feature without blocking boot." Payments is the only one that throws instead, and this phase
retires that exception:

| Xendit keys | `NODE_ENV` | Result |
|---|---|---|
| Both set | any | `XenditPaymentAdapter`. Unchanged — real money moves |
| Exactly one set | any | **Throws.** Unchanged, in every environment |
| Neither set | `development` / `test` | `FakePaymentAdapter`. Unchanged |
| Neither set | anything else | **Payments disabled.** Today this throws; now the API boots without a payment path |

**The rule that makes retiring the throw safe: absent keys must never mean "use the fake
adapter" outside `RELAXED_NODE_ENVS`.** That throw exists for a specific documented reason — the
fake adapter writes unrecoverable `fake-acct-*` ids into `creator.xendit_account_id` and would
take fake money for real. Replacing it with *disabled* removes the hazard; replacing it with
*fake* would ship exactly the disaster it was written to prevent. An implementer who "helpfully"
falls back to the fake here has reintroduced it.

Disabled means genuinely absent, not stubbed:

- `StartCheckout` is not constructed, and `POST /c/:slug/checkout` returns **404** — not a fake
  invoice, not a 500.
- A community whose `access_mode` is `paid` still renders, but has **no join path at all** —
  not checkout, and **not** the request form. It reads as "not accepting new members right now,"
  the wording paused communities already use.
- Setting or changing `access_mode` to `paid` is refused while payments are disabled.

That second point is the one an implementer is most likely to get wrong by being helpful.
Falling back to the request form for a `paid` community would hand out, for free, memberships
the owner priced — a silent giveaway triggered by nothing more than a missing environment
variable. A community whose owner chose `paid` accepts members only through payment, and if
payment is unavailable it accepts nobody.

**Retiring the throw is a deliberate loosening, and worth stating plainly.** It is safer than the
workaround it replaces: to run without Xendit today an operator must set
`NODE_ENV=development`, which relaxes *every* guard keyed to `RELAXED_NODE_ENVS`, not just this
one — and hands production the fake adapter into the bargain. After this change a production box
runs as `production`, with payments simply absent. That is a smaller blast radius than the state
it replaces, but it is only smaller because the last row of the table above says *disabled* and
not *fake*.

## 3. What does not change

- Members still have **no accounts**. Identity is the WhatsApp number
  (`findOrCreateByWhatsappNumber`).
- `GrantChannelAccess` is untouched. It already knows nothing about money — it is triggered by a
  `grant_access` outbox row, mints Telegram invite links and WhatsApps them. An approval enqueues
  the same row a payment does.
- Removal is untouched: `POST /:memberId/revoke` → `RevokeChannelAccess` already exists.
- Watch tokens and the streaming entitlement re-check are untouched. A free member holds an
  `active` subscription, so they can watch, and revoking them stops it mid-stream exactly as it
  does for a paying member.

## 4. Data model

**`community.access_mode`** — `varchar(16) not null default 'paid'`. Existing rows keep today's
behaviour without a backfill.

**`join_request`** — a new table:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `community_id` | uuid not null | → `community` |
| `tier_id` | uuid not null | → `membership_tier`; which channels they get |
| `member_id` | uuid not null | → `member` |
| `status` | varchar(16) not null default `'pending'` | `pending` / `approved` / `rejected` |
| `created_at` | timestamptz not null default now | |
| `decided_at` | timestamptz null | |
| `decided_by` | uuid null | → `creator` |

**A partial unique index on `(community_id, member_id) where status = 'pending'`** — one open
request per member per community, arbitrated by the database rather than by a read-then-write.
That is this project's established idempotency pattern, and the reason a duplicate submit cannot
create two rows.

Rejected and approved rows are retained. They are the audit trail of who decided what and when,
and rejection being silent (§7) makes that record the only account of it.

**Why a separate table rather than a `pending_approval` subscription status.** A declined request
would otherwise sit forever in the most important table in the system as a subscription that
never existed, and `subscription_member_tier_active_unique` only covers `status = 'active'`, so
nothing would stop a member accumulating pending rows. `subscription` keeps meaning "a
membership that is or once was live."

## 5. Tiers still apply, and they are free

A free community still has tiers, because **tier → channels** is what decides which Telegram
groups a member receives. A creator wanting one flat membership creates one tier; the request
form then selects it automatically rather than asking.

Free tiers carry `price_amount = 0`. `membership_tier.price_amount` is `not null`, so this needs
no schema change.

## 6. The member's flow

1. `GET /c/:slug` returns `accessMode` alongside the tiers it already returns.
2. When `accessMode` is `request`, `CheckoutPage` renders a **join request** form instead of a
   purchase: name, WhatsApp number, and tier (auto-selected when there is exactly one).
3. `POST /c/:slug/join-request` → **`RequestToJoin`**:
   - the community must be `active` **and** `access_mode = 'request'`
   - the tier must be active and belong to that community
   - `findOrCreateByWhatsappNumber`
   - refuse if the member already holds an `active` subscription to any tier in this community
   - refuse if a pending request already exists — caught by the unique index, not by a prior read
   - insert the request and enqueue a **`notify_join_request`** outbox row **in one transaction**,
     via the existing unit-of-work, so a request can never exist without its notification
4. The member lands on `/c/:slug/request/:joinRequestId`, which shows `pending`, `approved` or
   `rejected`. **Once approved it links to the subscription status page**, which is where the
   member reaches live streams — without that link an approved free member has no route to
   "Tonton sekarang."

## 7. The owner's flow

**Notification.** The worker consumes `notify_join_request` and WhatsApps the creator: who asked,
which tier, and where to decide. `creator.whatsapp_number` is **nullable**, so when it is absent
the row is consumed and recorded as undeliverable rather than retried forever — the dashboard
list is the fallback, not a nicety.

**The list.** `MembersPage` gains a **Permintaan bergabung** section: pending requests with name,
WhatsApp number, tier and age, plus a count so it is visible without scrolling.

**Approve** — `POST /communities/:communityId/join-requests/:requestId/approve`:
- owner-scoped; a stranger gets **404**, never 403
- refuse if already decided (409) — two owners clicking at once must not both approve
- in one transaction: mark the request `approved`, create a subscription with
  `status = 'active'` and **`next_billing_date = null`**, and enqueue `grant_access`
- writes an `activity_log` row, as every membership change already does

**Reject** — `POST .../reject`: mark `rejected`, record `decided_at`/`decided_by`, write
`activity_log`. **Silent — no message is sent.** A rejection notice invites an argument the owner
has no tool to handle. The member may request again; nothing blocks a second attempt.

## 8. Why the billing machinery leaves free members alone

An approved free subscription is `active` with a **null** `next_billing_date`. This is not an
assumption — `findDueForRenewal` carries an explicit `isNotNull(subscriptions.nextBillingDate)`
(`drizzle-subscription.repository.ts:315`), so:

- the renewal pass never selects it → it is never reminded
- it therefore never transitions to `past_due` → `findPastGraceDeadline` never selects it
- so the churn pass never revokes it

A free membership lasts until the owner removes it. **A test must pin this chain**, because it is
the difference between "free members are left alone" and "free members silently lose access on a
schedule."

## 9. Errors

| Condition | Behaviour |
|---|---|
| `POST /c/:slug/checkout` while payments are disabled | 404 — the route does not exist |
| Join request to a `paid` community | 404 on the request route, whether or not payments are configured — a paid community never accepts a free join |
| Join request to a paused or archived community | 409, the message `StartCheckout` already uses |
| Member already active in this community | 409, saying they are already a member and to check WhatsApp for their invite |
| Duplicate pending request | 409, saying the request is already waiting — never a second row |
| Approve/reject an already-decided request | 409 naming the decision already recorded |
| Approve a request whose tier was deleted or deactivated | 409; the owner reactivates the tier or rejects |
| Creator has no WhatsApp number | The notification row is consumed and recorded undeliverable; the dashboard still shows the request |
| Telegram invite minting fails after approval | Unchanged — `GrantChannelAccess` already records `access_manual_required` and tells the member the owner will add them manually |

## 10. Testing

- `RequestToJoin` per refusal in §9, against fakes.
- **A concurrency test that two simultaneous requests from one member produce one row**, proving
  the unique index arbitrates rather than the read.
- **A test that an approved free subscription is invisible to both `findDueForRenewal` and
  `findPastGraceDeadline`** — §8's chain, executed rather than reasoned.
- Approve is owner-scoped: a stranger gets 404, and the response leaks nothing.
- Approving twice enqueues **one** `grant_access` row.
- `selectPaymentProvider` with neither key set, per row of §2's table — in particular that
  outside `RELAXED_NODE_ENVS` it returns a disabled payment path rather than throwing, and that
  **the fake adapter is unreachable there**. The half-configured throw must still fire in every
  environment, with its existing tests unchanged.
- A community cannot be created with, or updated to, `access_mode = paid` while payments are
  disabled.
- Web: the checkout page renders the request form under `request` and the purchase form under
  `paid`; the owner's pending list renders, approves and rejects.

## 11. Honest limitations

**Anyone can submit a join request with any WhatsApp number.** There is no verification that the
submitter owns it — the same assumption the paid flow already makes, where the number is simply
where invites are sent. A bad actor can therefore create pending requests naming numbers that are
not theirs. The blast radius is small (the owner sees and rejects them; approving sends invites to
a number that did not ask), but it is real, and rate limiting the request endpoint is the obvious
follow-up. Deliberately out of scope here.

**No blocklist.** A rejected member may request again immediately, and nothing stops repeated
re-application. Chosen over a blocklist because a mis-tapped permanent block is irreversible
without support tooling that does not exist.

**No bulk approve.** A community receiving fifty requests approves them one at a time. Worth
revisiting once anyone has actually felt it.

**Switching a live community's `access_mode`** does not migrate existing members. Paying members
of a community switched to `request` keep their paid subscriptions and their renewal schedule;
free members of one switched to `paid` keep permanent access with a null due date. Both are the
correct conservative behaviour — nobody's access changes because a setting moved — but it means a
community can hold both kinds of member at once, and the members list should not pretend
otherwise.

**Still no real payment has ever been taken.** This phase makes that state shippable rather than
fixing it. Xendit, Telegram and Fonnte remain unverified against production credentials.
