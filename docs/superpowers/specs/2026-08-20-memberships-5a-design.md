# Memberships 5a — a user can sell a membership

Phase 5a of the DIUDARA pivot. Parent spec: `2026-08-17-member-ui-design.md` (§6, §7, §8).

**Status: approved in conversation, awaiting written review.**

---

## 1. Purpose

The pivot's whole point is that a creator sells memberships to their own audience, on their own
profile, in the same app that audience already uses. Everything before this phase built the audience:
accounts, profiles, following, posts, images. **This phase is the first one where money moves.**

Phase 6 gates content on membership. It cannot be built until the system can answer one question
cheaply and correctly: *is this viewer a paying member of that person?*

## 2. What the parent spec already settles

- **Managing your own memberships belongs on your own profile and in Pengaturan** (§6), not in the
  creator dashboard.
- **`/dashboard/*` keeps running untouched until Phase 8 deletes it** (§6). Nothing here may edit it,
  and nothing here may change the tables it reads.
- **All user-facing copy is Bahasa Indonesia.**

## 3. Decisions taken during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Production data | **Nothing real exists** — no live creators, communities or paying subscribers | Confirmed by the owner. So this phase gets to choose the right model rather than a compatible one, exactly as the reserved-handle decision did. |
| Scope | **The whole money path**, end to end | A tier nobody can buy delivers nothing, and Phase 6 cannot gate on a membership that cannot be acquired. |
| Subscriber identity | **Signed-in `app_user` only** | Phase 6 must recognise a member *while they browse*, which requires an account. Everything else in the pivot — following, posting, the feed — already requires one. The cost is friction at the moment of intent, accepted knowingly. |
| Relationship to the old world | **New user-scoped tables beside the old ones** | See §4. |
| Phase size | **Split: 5a sells, 5b services** | 5a is the smallest useful thing and the one Phase 6 needs. See §9 for what 5b owns. |

### 3.1 Why new tables rather than generalising the old ones

The old subscriber is a **WhatsApp number** (`member.whatsapp_number`, no account). The new one is an
**account**. Those are not two flavours of one row; they are different identity models.

Generalising `membership_tier` and `subscription` with nullable owner/subscriber columns and a check
constraint would make one table mean both — and, worse, would put rows the dashboard has no concept
of into the tables the dashboard reads. **Every dashboard query would need amending to exclude them**,
which is editing live code the parent spec says to leave untouched, to accommodate rows it should
never have seen.

Migrating creators into `app_user` now would be the cleanest end state and would lose nothing real,
but it breaks the same constraint: the dashboard reads those tables directly.

So: new tables, old world untouched, and **Phase 8 becomes a deletion rather than an untangling.**

The honest cost: two tier tables and two subscription tables coexist until Phase 8, and 5b will write
a second renewal implementation rather than sharing one.

## 4. The model

**`user_tier`**

| Column | Notes |
|---|---|
| `id` | uuid |
| `owner_id` | → `app_user`. The person selling. |
| `name` | e.g. "Anggota" |
| `price_amount` | integer rupiah, matching `membership_tier.price_amount`'s convention |
| `billing_cycle` | varchar, `monthly` for now — a varchar rather than an enum so 5b can add values without a migration, the reasoning `subscription.status` already records |
| `is_active` | a deactivated tier stops being offered; existing subscriptions are unaffected |
| `created_at` | |

Plus `unique (id, owner_id)` — redundant on its own, and it exists only to support the composite
foreign key below.

**`user_subscription`**

| Column | Notes |
|---|---|
| `id` | uuid |
| `subscriber_id` | → `app_user`. The person paying. |
| `tier_id` | |
| `owner_id` | **denormalised** — see below |
| `status` | `pending` \| `active` \| `cancelled`. 5b adds `past_due` and `churned`. |
| `current_period_end` | when this paid period runs out |
| `created_at` | |

Three constraints carry real weight:

- **`foreign key (tier_id, owner_id) → user_tier(id, owner_id)`.** `owner_id` is denormalised because
  Phase 6 asks "is this viewer a member of that person" on every gated post, and that must be one
  index hit rather than a join through the tier. The composite FK is what keeps the denormalisation
  honest: **a subscription whose owner disagrees with its tier's owner cannot be inserted.** No
  trigger, no application invariant anyone can forget.
- **`check (subscriber_id <> owner_id)`** — you cannot subscribe to yourself, exactly as
  `follow_no_self` already forbids following yourself.
- **partial `unique (subscriber_id, owner_id) where status = 'active'`** — nobody can hold two live
  memberships to the same person, which is the shape of accidentally paying twice.

**`app_user` gains `xendit_account_id`** (nullable), mirroring `creator.xendit_account_id`.

## 5. Payout onboarding

Pengaturan gains a "Terima pembayaran" section: connect an account, and see its status.

**This copies the creator flow's claim-first sentinel rather than reinventing it.** That discipline
exists because a measured race created **30 Xendit sub-accounts and orphaned 29** — and a managed
sub-account is a KYC entity that cannot be cleaned up afterwards. The hazard is identical here, so the
fix is identical: claim the row with a sentinel first, then call the provider.

**A tier cannot be published without a connected payout account.** A membership whose money has
nowhere to go is a trap for the buyer and the seller both.

This is the piece with a dependency outside the project's control: Xendit verifies each creator's
identity, and nothing here can make that faster.

## 6. Selling and buying

**Pengaturan** gets a tier editor — create, edit, deactivate.

**A profile** shows the offer and a **"Jadi anggota"** button.

**Buying is signed-in only.** A signed-out visitor pressing the button goes to Masuk first.

`POST /users/:handle/subscribe` with a tier id:

1. Refuses if the viewer is the owner, if the tier is inactive, if the owner has no payout account, or
   if the viewer already holds an active membership to this owner.
2. Creates a `pending` `user_subscription`.
3. Opens a Xendit invoice against the owner's sub-account with the existing split rule.
4. Returns the invoice URL for the browser to follow.

## 7. The webhook, where money and truth meet

Xendit delivers **one** webhook stream, and the existing handler already resolves community
subscriptions. User subscriptions are distinguished by an **`external_id` namespace**, not by
guessing: an unrecognised prefix is **ignored**, never assumed to be either kind.

Three properties, each of which the existing handler learned the hard way and none of which may be
re-learned here:

- **Amount verification.** A claimed amount is not a paid amount. The existing code logs
  `[security] webhook amount mismatch` because this was a real finding.
- **Idempotency.** A webhook delivered twice must not activate twice, nor extend a period twice.
- **Only `PAID` activates.** Every other status is recorded and does nothing.

## 8. What Phase 6 needs from this, and gets

One question, answerable with a single index hit:

```
isMemberOf(viewerId, ownerId) -> boolean
```

satisfied by `status = 'active' and current_period_end > now()` against the partial unique index.

## 9. The honest limitation

**A subscription created in 5a is active for exactly one period, and nothing renews or expires it.**
There is no renewal pass, no grace period, no churn, and no way to cancel from the UI.

So a member's access **lapses after one period with no way to renew until 5b ships.** That is not a
flaw in the split; it is the cost of it, and it argues 5b should follow closely rather than after
Phase 6.

**5b owns:** renewals, grace, churn, cancelling, the subscriber list on a profile, and the
`whatsapp_number` notification fix from parent §7 — which is unrelated to memberships and shares
nothing with them except a table cell.

## 10. Testing

Beyond the usual coverage, three things in this phase are only provable in particular ways:

- **The payout race.** The claim-first sentinel must be proven under concurrency, the way the
  creator flow's was: N concurrent connect requests must produce exactly one sub-account. A
  sequential test proves nothing about the bug this design exists to prevent.
- **Webhook idempotency and amount verification** must be asserted against replayed and tampered
  payloads, not just a happy-path `PAID`.
- **The composite foreign key** must be shown to *reject* a mismatched owner at the database level.
  A test that only inserts consistent rows proves nothing about the constraint.

## 11. Out of scope

Refunds, proration, price changes for existing members, multiple concurrent tiers per member,
tier-level perks beyond existence, anything in `/dashboard/*`, and any change to the community-scoped
tables the dashboard reads.
