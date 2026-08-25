# Free memberships, by request — design

**Date:** 2026-08-25
**Status:** awaiting review
**Phase:** 9 (post-pivot), following Phase 5a/5b memberships and Phase 6 exclusive content

## 1. The problem

A creator can only offer a **paid** tier, and only after connecting a Xendit payout
account. On a box with payments disabled — which is every box until `XENDIT_SECRET_KEY`
and `XENDIT_SPLIT_RULE_ID` are set — the whole membership feature is unreachable:

| Step | Today |
|---|---|
| Connect payout | `POST /users/me/payout` → **503**, payments disabled |
| Create a tier | refused: no connected payout account |
| Profile shows an offer | nothing to show: **0 tiers exist in the database** |
| "Jadi anggota untuk melihat" | links to `/@handle` — the page you are already on |

So a member cannot be made at all, and gated photos cannot be tested by anyone but
their author. The request that prompted this: a creator should be able to offer
membership **for free**, granted by **approving a request**, alongside paid tiers.

## 2. Decisions taken

1. **A free membership is granted by the owner approving a request**, not instantly.
2. **A free membership never expires** until cancelled or revoked.
3. **A free tier needs no payout account.** Money never moves, so there is nothing for
   a payout account to receive.
4. **Free vs paid is derived from `price_amount === 0`.** One source of truth; no second
   flag that can contradict the price.

## 3. `current_period_end` must NOT be overloaded

`is-member-of.ts` today treats a `null` `current_period_end` on an `active` row as
**lapsed**, deliberately, and its docstring gives the reason: the state is unreachable
(`activate(id, periodEnd)` is its only writer and always sets one), so if it ever
appeared it would be a **bug**, and answering `member` would grant permanent access to
gated content on the strength of a bug.

A free membership needs a row that is active with no expiry — exactly that shape. Making
`null` mean "free forever" would delete the guard: any future bug leaving a *paid* row
with `null` would silently grant permanent free access to every gated photo.

**Therefore the row says which kind it is.** New column:

```
user_subscription.kind  varchar(16) NOT NULL DEFAULT 'paid'   -- 'paid' | 'free'
```

`varchar`, not an enum, for the reason `subscription.status` and `post.visibility`
already record: a later value needs no migration. The `DEFAULT 'paid'` makes the
migration additive and leaves every existing row exactly as it is.

The predicate becomes:

```
member  ⇔  status = 'active' AND (kind = 'free' OR current_period_end > now())
```

A paid row with `null` still reads `lapsed`. The guard survives; free membership becomes
explicit rather than inferred from an absence.

**`membershipStanding` stays the single definition.** It is a pure function over the row,
read by both `IsMemberOf` (the profile) and `StartUserSubscription` (the refusal it words).
A second copy of this comparison is precisely what would drift — a whole-branch review
already flagged `is-member-of.ts` and `listActiveOwnersAmong` as able to drift apart, and
**both** must move together here.

### 3.1 Every site that compares `current_period_end`

All of these are in `drizzle-user-subscription.repository.ts` unless noted, and each one
must be considered explicitly rather than found later:

| Site | Change |
|---|---|
| `membershipStanding` (`is-member-of.ts`) | add the `kind = 'free'` disjunct |
| `findActiveFor` | returns the row; must now select `kind` |
| `listActiveOwnersAmong` (Phase 6's bulk paywall read) | add the same disjunct — **this is the one that gates photos in the feed** |
| `listActiveSubscribers` (the owner's subscriber list) | add the disjunct, so free members appear |
| the expiry sweep (`status='active' AND current_period_end <= now`) | **no change**: `null <= now` is `NULL`, never true, so free rows are already skipped. Assert this rather than assume it. |
| `remind-expiring-membership` | **no change** for the same reason; assert it does not remind a free member |

## 4. Tier rules

`manage-user-tiers.ts` today:

```ts
if (!Number.isInteger(input.priceAmount) || input.priceAmount <= 0) { ...refuse }
const payout = await this.payouts.findPayoutAccount(input.ownerId);
if (!payout) { ...refuse }
if (!isConnectedPaymentAccount(payout.xenditAccountId)) { ...refuse }
```

Becomes:

- `priceAmount` must be an integer `>= 0`. Zero is a free tier.
- The payout checks run **only when `priceAmount > 0`**.
- A free tier's `billing_cycle` is still stored (the column is `NOT NULL`) but means
  nothing; it is not read for a free tier. Spec-level note so nobody later "fixes" a
  free tier's cycle into a renewal.

## 5. The join flow

### 5.1 Requesting

`POST /users/:handle/subscribe` with a **free** tier creates the `pending` row the schema
already supports, with `kind = 'free'`, and returns no payment URL.

Double-requesting is refused by `user_subscription_one_pending` — the existing partial
unique index — not by a read-then-write check. The database arbitrates.

### 5.2 The blocker this exposes

`StartUserSubscription`'s constructor takes `payments: PaymentProviderPort`, and
`bootstrap.ts` builds it as `payments ? new StartUserSubscription(...) : undefined`, so
`POST /users/:handle/subscribe` **503s on a payments-disabled box regardless of tier
price**. A free join that reuses this route is unreachable until that changes.

**Resolution:** `payments` becomes `PaymentProviderPort | null` and the use case is
constructed unconditionally. It throws only when a **paid** tier is chosen on a box with
no provider — the same 503 as today, now decided by the tier rather than by boot. One
place still answers "can this person subscribe to this tier", which is why this is
preferred over a second `RequestFreeMembership` use case that would duplicate the
self-subscribe, already-a-member and tier-exists guards.

### 5.3 Approving and rejecting

Three new owner-only endpoints:

| Route | Effect |
|---|---|
| `GET /users/me/membership-requests` | the owner's pending free requests |
| `POST /users/me/membership-requests/:id/approve` | `pending` → `active`, `kind='free'`, `current_period_end` left `NULL` |
| `POST /users/me/membership-requests/:id/reject` | deletes the pending row |

Static segments, like `me/tiers` and `me/payout`, and registered before `/:handle` for the
reason that route's own comment gives. `membership-requests` joins `RESERVED_HANDLES`.

**Approval is a conditional UPDATE**, never read-then-write: the `WHERE` names the row id,
the owner, and `status = 'pending'`, so two approvals race to one winner and the second
changes nothing. Approving must also collide correctly with
`user_subscription_one_active` — a person who already has an active membership cannot be
approved into a second one; the index refuses it and the use case turns that into a
conflict rather than a 500.

Rejection is a delete so the requester may ask again later. A rejected-and-remembered
state is explicitly **not** built; there is no block list in this design.

## 6. Wire format

`TierView` gains nothing — `priceAmount: 0` already tells the client a tier is free.

`PublicUserProfile.membership` ALREADY EXISTS and already carries three fields:

```
membership: { tiers: TierView[], viewerIsMember: boolean, viewerMembershipEnded: boolean }
```

It gains ONE field, additively:

```
viewerRequestPending: boolean
```

**Additive, not a rewrite.** Replacing those two booleans with a single
`standing: "none" | "pending" | "member" | "lapsed"` enum reads better and is the wrong
choice here: it is a breaking wire change, and `ProfilePage.tsx` already defends against
deploy skew explicitly (`profile.membership?.tiers ?? []`, with a comment naming a
response that predates Task 5). A new boolean defaults to `false` on an old response,
which is the truthful answer for a client that cannot request anything yet.

`membershipStanding`'s four-state vocabulary stays SERVER-SIDE, where it already lives.
It gains no `pending` member: that function answers over the one row `findActiveFor`
returns, which is an ACTIVE row by definition. A pending request is a different question
against a different row, answered separately and projected as the boolean above.

Every projection stays a closed wire shape asserted with `Object.keys(...).sort()` against
a literal, as elsewhere — so this field must be added to that literal in the same commit,
or the projection test fails, which is the intended behaviour.

## 7. Web surfaces

**Settings** — the tier form accepts `0` and labels it as free; a new "Permintaan
keanggotaan" list shows pending requesters with approve/reject.

**Profile** (`MembershipOffer`) — a free tier renders **"Minta jadi anggota"**; once
requested it renders a non-interactive "Menunggu persetujuan"; once approved the offer is
replaced by member state. Copy is Indonesian, matching the surrounding surfaces.

**PostCard's lock CTA** — currently `<Link to={"/@" + handle}>`, which is a no-op when the
reader is already on that profile. It becomes a scroll to the membership offer when the
offer is on the current page, and keeps the link otherwise. If the author offers **no**
tier at all, the card must not promise "Jadi anggota untuk melihat" — it says the photos
are for members without offering a door that does not exist.

## 8. What this design does NOT do

- **No block list.** A rejected requester may request again.
- **No cancellation by the member.** Leaving a free membership is not built.
- **No revocation by the owner** after approval. Both are follow-ups.
- **No notification** on request or approval. The outbox exists but wiring it is separate.
- **No change to paid tiers**, beyond the payout check becoming conditional and the
  provider becoming nullable.

## 9. Risks

**The paywall predicate is the whole risk.** `listActiveOwnersAmong` decides whether a
gated photo is served in the feed; a wrong disjunct there leaks every gated photo of every
creator to everyone. Its test must include a **paid, lapsed** row proving it is still
refused after the change, not only a free row proving it is allowed.

**A free tier switched to paid, or the reverse.** `PATCH /users/me/tiers/:tierId` today
only edits `is_active`. This design does not add price editing; a creator makes a new tier.
Named here so nobody adds it casually — changing a tier's price would silently change the
meaning of every existing subscription row pointing at it.

**Approval racing activation.** Covered by the conditional UPDATE and the existing
`user_subscription_one_active` index, and must be tested by concurrent approval, not by
reading the code.

**A LAPSED PAID MEMBER CANNOT REQUEST A FREE TIER, and this is not obvious.**
`StartUserSubscription`'s existing refusal is deliberately STATUS-ONLY — a lapsed row is
still `status = 'active'`, and the guard must stay status-only because a lapsed row let
past it collides with `user_subscription_one_active` at activation time, turning a broken
button into *charged and not activated*. So a creator's former paying member, whose row
sits active-but-expired forever (5a has no renewal pass), is refused a free request with
"you are already a member" — which is exactly the false statement `lapsed` was introduced
to stop the app making.

This design does NOT resolve it, and must not pretend to: the fix is a way to retire a
lapsed row, which is the cancellation/revocation work §8 defers. What the implementation
MUST do is make the refusal say something true — the requester is told their previous
membership has ended and cannot currently be replaced — rather than "you are already a
member". A test names this case explicitly so the next person meets it as a decision
rather than as a bug report.
