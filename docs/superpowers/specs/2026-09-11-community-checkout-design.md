# Phase 5 — Per-community checkout

**Date:** 2026-09-11
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 4a, `2026-09-11-community-documents-design.md` (merged)
**Branch:** `feat/udara-checkout`

## Goal

A community owner can offer paid membership tiers. A member can buy one, pay
through Xendit, and come back to a community where the documents marked
members-only are now readable.

## What this phase does NOT rebuild

Everything about taking money already exists, built in Phases 5a and 5b of the
pre-pivot programme for **personal** memberships: invoice creation through
`PaymentProviderPort`, the Xendit webhook, `user_transaction` as the ledger,
the five scheduled worker passes that expire and renew, and
`membership_reminder`.

**A community tier is the same tier with an owner that happens to be a
community.** `user_tier` gains one nullable column and every one of those
mechanisms is reused untouched. The alternative — `community_tier`,
`community_subscription`, `community_transaction` — is Phases 5a and 5b
rebuilt beside themselves, including a second renewal pass and a second
reminder flow, which is the reasoning Phase 2 recorded when community posts
reused `post`.

## The schema

### `user_tier` gains one column

```
community_id  uuid NULL REFERENCES community(id)
```

`NULL` means a personal tier — a tier on somebody's profile, which is what
every existing row is, and nothing about those changes. Non-null means a
community tier.

Additive with no default to backfill: every existing row becomes a personal
tier, which is what it already was.

### `community_document` gains one column

```
members_only  boolean NOT NULL DEFAULT false
```

**Because a tier that unlocks nothing is worse than no tier at all.** Phase 5
has to gate exactly one thing to be coherent, and the library Phase 4a just
built is the cheapest: one column, one checkbox on the upload control, and one
extra branch in a gate that already exists.

`false` by default, so every document uploaded before this phase stays exactly
as readable as it was.

### `user_subscription` gains NOTHING

It already carries `subscriber_id`, `tier_id`, `owner_id`, `status`, `kind`
and `current_period_end`. Which community a subscription is for is reachable
by joining `user_tier` on `tier_id` — see **The gate** for why that join is
used rather than a denormalised column.

### The composite foreign key stays, and it constrains the payout

`user_subscription` already carries

```
foreign key (tier_id, owner_id) references user_tier (id, owner_id)
```

which exists, in `StartUserSubscription`'s own words, to make "charging THIS
owner's account for THAT owner's tier" impossible. It is not relaxed here. A
community tier's `owner_id` is the community's owner, so the key holds
unchanged and the payout destination is still the tier's own owner.

**Checkout additionally asserts `tier.ownerId === community.ownerId`.** That is
trivially true today because nothing transfers community ownership — but it is
the line that fails loudly, rather than paying a former owner, if a transfer
feature ever ships without migrating that community's tiers. It is cheaper to
write now than to discover later.

## The gate, and the conflation it has to avoid

**This is the most dangerous part of the phase, and it is dangerous in a quiet
way.**

`IsMemberOf` answers "is this viewer a member of this owner" through
`subscriptions.findActiveFor(viewerId, ownerId)` — a lookup keyed on the
SUBSCRIBER and the OWNER. A community tier's owner is a person who may also
sell personal tiers on their own profile. So asking that question with
`community.ownerId` would answer **true for somebody who subscribed to the
owner personally and never paid the community a rupiah** — and, symmetrically,
a community subscription would unlock that owner's gated personal photos.

Neither direction is visible in a test that only ever creates one kind of
subscription, which is precisely the shape Phase 2 recorded when a
`deleted_at` filter was present on three read paths and missing on the fourth.

So the community gate does **not** reuse `findActiveFor`. It is a new
repository method keyed on the community:

```
findActiveForCommunity(subscriberId, communityId, now)
  -> user_subscription JOIN user_tier ON user_tier.id = user_subscription.tier_id
     WHERE user_tier.community_id = $communityId
       AND user_subscription.subscriber_id = $subscriberId
       AND status = 'active'
       AND (current_period_end IS NULL OR current_period_end > now)
```

A JOIN rather than a denormalised `community_id` on `user_subscription`,
because the tier already names the community and a second copy is a second
thing to keep in step — the opposite call from `community_event.community_id`
in Phase 3, and for the opposite reason: that column exists to be *ranged
over* by the calendar, while this one would only ever be equality-matched on a
row we are already joining.

**The owner is entitled without a subscription.** `user_subscription_no_self`
forbids subscribing to yourself, so a community's owner can never hold a
subscription to their own tier. The gate therefore answers `true` for the
owner directly, before it asks about subscriptions at all.

### What the gate governs

```
viewerMayDownload(document) =
  viewer is the community's owner                                   -> true
  document.members_only = false AND viewer is a member              -> true
  document.members_only = true  AND viewer has an active community
                                    subscription                     -> true
  otherwise                                                          -> false
```

`ListCommunityDocuments` currently returns ONE `viewerMayDownload` for the
whole page. That becomes per-document, because the answer now differs row by
row. The download route applies the same rule again server-side — the list's
flag decides what CONTROL is rendered, never what bytes are served.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/communities/:slug/tiers` | none — the offer |
| `POST` | `/communities/:slug/tiers` | owner |
| `PATCH` | `/communities/:slug/tiers/:tierId` | owner — `isActive` only |
| `POST` | `/communities/:slug/subscribe` | member |

`POST /communities/:slug/subscribe` mirrors `POST /users/:handle/subscribe`
exactly: it resolves the seller, checks the tier belongs to them, refuses a
deactivated tier, and returns either an `invoiceUrl` to follow or — for a free
tier — nothing to follow. The Xendit webhook, the success redirect and
`APP_BASE_URL` are all reused as they are.

**Subscribing requires membership first.** Joining is free and one click, so
this costs the buyer nothing, and it keeps one rule true: every subscriber is
a member, so the gate never has to handle "paid but not joined".

**`PATCH` carries `isActive` and nothing else**, matching
`PATCH /users/me/tiers/:tierId`. A tier's price never changes — the existing
tier system already decided that, on the ground that a subscription's price is
the tier's price at purchase and an edited price would silently reprice
everybody.

**A paid community tier still needs a connected payout account.**
`ManageUserTiers` already refuses to publish a paid tier without one; the
community path calls the same check against the community owner's account.

## The web app

**The community page gains a tier offer** for a member who has not subscribed,
reusing `MembershipOffer`'s shape rather than a second component — the rule
that kept `PostCard` singular through Phases 2 and 3.

**The owner manages tiers from the community page**, not from
`/pengaturan`: a community tier belongs to the community, and putting it under
personal settings is how somebody publishes a tier on the wrong thing.

**The Dokumen tab's upload control gains a "Khusus anggota berbayar"
checkbox**, and a marked row renders a lock instead of a download for a viewer
without an active subscription — pointing at the offer, never rendering a
control that would fail.

**The success page already exists.** Xendit returns the payer to
`APP_BASE_URL`'s existing confirmation route, which reads the subscription
rather than the community, so it needs no change.

## Not in this phase

- **Gating community POSTS behind tiers.** `post.visibility = 'members'` is
  forbidden on community posts by the `post_community_is_public` CHECK, whose
  comment explains at length that it would gate against the author's PERSONAL
  tier — locking out a community member and letting in a personal subscriber.
  Redefining it to mean "the community's tiers" is correct and is exactly the
  conflation this spec's **The gate** section is about; it rewrites a
  load-bearing constraint and belongs in its own change, not riding along with
  checkout.
- **Upgrades, downgrades and proration.** Cancel and re-subscribe.
- **Refunds.** Not built for personal tiers either.
- **Per-community payout splits** beyond what the existing Xendit split rule
  does.
- **A tier's own gated posts, events or calendar.** Documents are the one
  gated surface this phase adds.
- **Free community tiers by request.** The personal system has them
  (`membership_request`, `kind = 'free'`); a community's free access is
  joining, which is already free and one click.

## Testing

**The conflation gets a test that cannot pass by omission, in both
directions.** One fixture: an owner who sells a personal tier AND a community
tier, a buyer who holds only the personal subscription, and a buyer who holds
only the community one. Then a table asserts that the personal subscriber
cannot download a members-only community document, and that the community
subscriber cannot see that owner's gated personal photos. Two tests that each
create one kind of subscription would both pass while the gate was wrong.

**The payout guard gets a test that forces the disagreement.** The
`tier.ownerId === community.ownerId` assertion is unreachable through the
normal API today, so the test writes a community whose `owner_id` no longer
matches its tier's and asserts checkout refuses rather than invoices. Without
it, the guard is a line nobody has ever executed.

**Every existing personal-membership test stays green untouched.** That is the
proof the `community_id` column is additive. Any one of them needing an edit
is a signal to stop and look.

Beyond that:

- A tier with `community_id` set is absent from `/users/me/tiers`, and a
  personal tier is absent from `/communities/:slug/tiers`. Asserted from one
  fixture holding both, for the same reason the conflation test is.
- A document with `members_only = false` stays downloadable by any member,
  including in a community that has paid tiers — the proof this is per-document
  and not per-community.
- The owner downloads a members-only document without any subscription.
- `POST /communities/:slug/subscribe` refuses a non-member, a deactivated
  tier, another community's tier, and an unknown slug, each with its own status.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.
No Playwright run and no dev server is part of this phase's verification.

## Risks

**One table now feeds two products.** `user_tier` and `user_subscription` serve
personal memberships and community memberships at once, and the read paths for
each must never answer for the other. **The gate** names the exact failure and
**Testing** names the fixture that holds it, but this is the risk to re-read
before touching either table again.

**Money is involved and this phase is not the place to be clever.** Every
change here is additive: one nullable column, one boolean, one new repository
method, four new routes. Nothing in the existing invoice, webhook or renewal
path is edited. If a change to this phase seems to require editing one of
those, that is the signal to stop rather than the signal to be careful.
