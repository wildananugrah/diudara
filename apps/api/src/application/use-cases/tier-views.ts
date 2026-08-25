import type { UserTierRow } from "../ports/user-tier-repository.port";
import type { UserSubscriptionRow } from "../ports/user-subscription-repository.port";
import type { MembershipStanding } from "./is-member-of";

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
 * **`viewerMembershipEnded` is the second half of the same answer, and what it
 * MEANS changed with Phase 5b.** Every paying member lapses one billing cycle
 * after their purchase, so `viewerIsMember` goes `false` — and one boolean
 * cannot say which kind of "not a member" that is.
 *
 * In 5a the second boolean meant "no, and you cannot buy": the profile used to
 * render the offer and a "Jadi anggota" button that `StartUserSubscription`
 * answered 409 to, permanently, because ITS refusal reads the status alone (and
 * must: a lapsed row let past that guard collides with
 * `user_subscription_one_active` at activation), and nothing in 5a ever moved
 * such a row. So the web withheld the button.
 *
 * **5b made the lapsed row buyable, and the web kept withholding it** — the
 * final whole-branch review's C-1, and the reason this docstring is worth
 * reading before touching either side. `StartUserSubscription` now calls
 * `retireExpired` INSIDE the purchase transaction, which frees the partial
 * unique index's slot and lets the same tap open a fresh invoice; there is no
 * renewal endpoint because buying again IS the renewal here. So this boolean no
 * longer withholds anything. It selects a SENTENCE — "your membership ended",
 * standing above the offer every other non-member sees — and the offer itself
 * is decided by `viewerIsMember` alone.
 *
 * That is why the projection still carries the tiers for a `lapsed` viewer, and
 * why it must keep doing so: withholding them here is the server-side shape of
 * the same defect. `MembershipOffer` cannot render a button for a tier it was
 * never sent.
 *
 * The pair still comes from one `MembershipStanding`, which makes the
 * contradictory combination (`true`/`true`) unrepresentable rather than merely
 * unlikely.
 *
 * Also `false`, never `null`, for an anonymous visitor, for the identical
 * reason: it too is a claim about the caller.
 *
 * The projection stays CLOSED at exactly these four keys. This endpoint is
 * public, so anything added here is public too — and all three viewer
 * booleans are about the CALLER rather than about the creator being viewed,
 * which is precisely the kind of field that must not grow neighbours by
 * accident (a period end, a tier id, a subscription id would each be a new
 * disclosure, and a DATE would be one even here: "ended" is all the web
 * needs to stop offering, and it discloses nothing a renewal endpoint would
 * not).
 */
export interface MembershipView {
  tiers: TierView[];
  viewerIsMember: boolean;
  viewerMembershipEnded: boolean;
  /**
   * Task 6 of "free memberships": is a FREE request from this viewer, to
   * this creator, awaiting the owner's decision — so the web can say "your
   * request is awaiting approval" instead of re-offering the tier.
   *
   * **`false`, never `null` or `undefined`, for a signed-out viewer** —
   * identical reasoning to `viewerIsMember`'s own docstring above: this is a
   * claim about the CALLER, and for somebody we cannot identify the only
   * honest answer is "no", never a tri-state a client could mishandle into
   * "yes". It is also `false` on the viewer's own profile without a query —
   * nobody can have a pending request with themselves, the same way nobody
   * can be a member of themselves.
   *
   * **TRUE ONLY FOR A FREE PENDING ROW, deliberately not a paid one.** The
   * repository read behind this (`findPendingFor`) answers a broader
   * question — is there ANY `status = 'pending'` row for this pair, paid
   * checkout or free request alike — because that is the truthful shape of
   * "pending" and it is what a second caller (a second-tap guard) would also
   * need un-narrowed. This projection is where the narrowing happens: a PAID
   * pending row means the viewer has an open invoice and is mid-payment, and
   * telling that person "your request is awaiting approval" would be a lie —
   * they are not waiting on the owner, they are waiting on themselves to pay.
   * `kind === "free"` is the one predicate that tells the two apart, since a
   * free request never has a transaction or an invoice to check instead.
   */
  viewerRequestPending: boolean;
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
 * `standing` is a REQUIRED parameter with no default, so every caller has to
 * decide what it means for the viewer it is answering — a default of `"none"`
 * here would let a caller that forgot to ask the question ship a confident
 * "not a member, go ahead and buy" that looks identical to a real one.
 *
 * `pending` is likewise REQUIRED, for the identical reason, and it is the
 * WHOLE row (or `null`), not a pre-narrowed boolean — `UserSubscriptionRow`
 * `findPendingFor` returns, so this function is where `kind === "free"` gets
 * checked (see `MembershipView.viewerRequestPending`'s own docstring for why
 * a PAID pending row must answer `false`, not `true`). A caller that already
 * knows there is no viewer (anonymous, or the viewer's own profile) passes
 * `null` without ever querying — see `GetUserProfile.execute`.
 *
 * It arrives as the STANDING rather than as two booleans because the two
 * booleans have an impossible combination: nobody is simultaneously a live
 * member and a lapsed one. Deriving both here from one value is what makes
 * that combination unrepresentable, instead of a rule a future caller has to
 * remember. `IsMemberOf.describe` is the only thing that produces one.
 *
 * `tiers` is always an array, even when `rows` is empty — a profile with no
 * tiers (or, equivalently, no connected payout account, since
 * `ManageUserTiers.create` refuses to publish a tier without one) reports
 * `{ tiers: [] }`, never an omitted `membership` key. The web must never
 * branch on `undefined` here: Phase 4 shipped a version of that mistake and
 * it produced a white screen during a deploy (memberships-5a spec, Task 5
 * brief).
 */
export function toMembershipView(
  rows: UserTierRow[],
  standing: MembershipStanding,
  pending: UserSubscriptionRow | null
): MembershipView {
  return {
    tiers: rows.map(toTierView),
    viewerIsMember: standing === "member",
    viewerMembershipEnded: standing === "lapsed",
    viewerRequestPending: pending !== null && pending.kind === "free",
  };
}
