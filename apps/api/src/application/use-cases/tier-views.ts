import type { UserTierRow } from "../ports/user-tier-repository.port";

/**
 * A membership tier as a VISITOR sees it on a creator's public profile.
 * EXACTLY four fields: `UserTierRow` also carries `ownerId`, `isActive` and
 * `createdAt`, and none of those is a visitor's business — `ownerId` would
 * identify the seller independently of the profile the visitor is already
 * looking at, `isActive` only matters to the owner's own tier editor
 * (`ManageUserTiers.list`, never this file), and `createdAt` is bookkeeping.
 *
 * Its own file rather than a widening of `post-views.ts`: a tier is not a
 * post, and `post-views.ts` exists specifically so the post projection has
 * exactly one owner (Task 5 pre-flight ruling, memberships-5a spec §6).
 */
export interface TierView {
  id: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
}

/**
 * `membership` on `PublicUserProfile`. `tiers` is REQUIRED, never optional —
 * see `toMembershipView`'s own docstring for why an empty list is not the
 * same as an absent field.
 *
 * **`viewerIsMember` is `false`, never `null`, for a visitor with no
 * session** — deliberately unlike its neighbour `viewerFollows`, which IS
 * tri-state on the very same payload. The two answer different kinds of
 * question and fail differently when a client gets them wrong:
 *
 *  - `viewerFollows` DRIVES a toggle. Its three values are three different
 *    controls (a link to Masuk, "Ikuti", "Mengikuti"), so collapsing `null`
 *    into `false` makes an anonymous visitor look like a signed-in
 *    non-follower and offers them a button that cannot work.
 *  - `viewerIsMember` gates a CLAIM the page makes ABOUT the caller — "Anda
 *    sudah menjadi anggota". For somebody we cannot identify, the only safe
 *    answer to that claim is "no", and a tri-state would invite a client to
 *    write `!== false` and tell an anonymous visitor they are a member. A
 *    signed-out visitor genuinely holds no membership: there is no viewer to
 *    hold one.
 *
 * Nothing is lost by not distinguishing them here, because the web already
 * knows whether it has a session — it renders "Masuk untuk jadi anggota" from
 * its OWN token, not from this field.
 *
 * The projection stays CLOSED at exactly these two keys. This endpoint is
 * public, so anything added here is public too — and `viewerIsMember` is the
 * first thing on it that is about the CALLER rather than about the creator
 * being viewed, which is precisely the kind of field that must not grow
 * neighbours by accident (a period end, a tier id, a subscription id would
 * each be a new disclosure).
 */
export interface MembershipView {
  tiers: TierView[];
  viewerIsMember: boolean;
}

export function toTierView(row: UserTierRow): TierView {
  return {
    id: row.id,
    name: row.name,
    priceAmount: row.priceAmount,
    billingCycle: row.billingCycle,
  };
}

/**
 * `rows` is whatever `UserTierRepositoryPort.listActiveByOwner` returned —
 * already scoped to one owner and already filtered to `is_active = true` by
 * that single query (its own port docstring and
 * `DrizzleUserTierRepository.listActiveByOwner`). This function does not
 * re-filter; it only reshapes what it is given.
 *
 * `viewerIsMember` is a REQUIRED parameter with no default, so every caller
 * has to decide what it means for the viewer it is answering — a default of
 * `false` here would let a caller that forgot to ask the question ship a
 * confident "no" that looks identical to a real one.
 *
 * `tiers` is always an array, even when `rows` is empty — a profile with no
 * tiers (or, equivalently, no connected payout account, since
 * `ManageUserTiers.create` refuses to publish a tier without one) reports
 * `{ tiers: [] }`, never an omitted `membership` key. The web must never
 * branch on `undefined` here: Phase 4 shipped a version of that mistake and
 * it produced a white screen during a deploy (memberships-5a spec, Task 5
 * brief).
 */
export function toMembershipView(rows: UserTierRow[], viewerIsMember: boolean): MembershipView {
  return { tiers: rows.map(toTierView), viewerIsMember };
}
