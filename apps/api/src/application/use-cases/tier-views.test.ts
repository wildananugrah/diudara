import { describe, expect, it } from "bun:test";
import type { UserTierRow } from "../ports/user-tier-repository.port";
import type { UserSubscriptionRow } from "../ports/user-subscription-repository.port";
import { toMembershipView, toTierView } from "./tier-views";

function tierRow(overrides: Partial<UserTierRow> = {}): UserTierRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000000",
    ownerId: "eeeeeeee-0000-4000-8000-000000000000",
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
    isActive: true,
    createdAt: new Date("2026-08-18T02:00:00.000Z"),
    ...overrides,
  };
}

/** A `status = 'pending'` row, exactly the shape `findPendingFor` hands back. */
function pendingRow(overrides: Partial<UserSubscriptionRow> = {}): UserSubscriptionRow {
  return {
    id: "sub-pending-1",
    subscriberId: "viewer-1",
    tierId: "aaaaaaaa-0000-4000-8000-000000000000",
    ownerId: "eeeeeeee-0000-4000-8000-000000000000",
    status: "pending",
    kind: "free",
    currentPeriodEnd: null,
    createdAt: new Date("2026-08-18T02:00:00.000Z"),
    ...overrides,
  };
}

describe("toTierView", () => {
  /**
   * The projection is closed: a `UserTierRow` also carries `ownerId`,
   * `isActive` and `createdAt`, and none of those is a visitor's business —
   * `ownerId` would identify the seller independently of the profile the
   * visitor is already looking at, `isActive` only matters to the owner's
   * own tier editor, and `createdAt` is bookkeeping. Asserted on
   * `Object.keys(...).sort()`, not by spot-checking a field, the same
   * discipline `post-views.test.ts` uses for `toPostView`.
   */
  it("returns EXACTLY id, name, priceAmount and billingCycle — never ownerId, isActive or createdAt", () => {
    const view = toTierView(tierRow());

    expect(Object.keys(view).sort()).toEqual(["billingCycle", "id", "name", "priceAmount"]);
    expect(view).toEqual({
      id: "aaaaaaaa-0000-4000-8000-000000000000",
      name: "Anggota",
      priceAmount: 50_000,
      billingCycle: "monthly",
    });
  });
});

describe("toMembershipView", () => {
  it("wraps tiers under `tiers`, mapped through toTierView, in the given order", () => {
    const view = toMembershipView(
      [tierRow({ id: "tier-1", name: "Perak" }), tierRow({ id: "tier-2", name: "Emas" })],
      "none",
      null
    );

    expect(Object.keys(view).sort()).toEqual([
      "tiers",
      "viewerIsMember",
      "viewerMembershipEnded",
      "viewerRequestPending",
    ]);
    expect(view.tiers).toEqual([
      { id: "tier-1", name: "Perak", priceAmount: 50_000, billingCycle: "monthly" },
      { id: "tier-2", name: "Emas", priceAmount: 50_000, billingCycle: "monthly" },
    ]);
  });

  /**
   * An owner with no active tiers reports an EMPTY list, not an omitted
   * field — the web must never branch on `undefined` here (spec's Phase 4
   * white-screen incident, referenced in Task 5's brief).
   */
  it("an owner with no active tiers gets an EMPTY array, not an omitted or undefined field", () => {
    const view = toMembershipView([], "none", null);

    expect("tiers" in view).toBe(true);
    expect(view.tiers).toEqual([]);
  });

  /**
   * Task 10 (spec §6): "an already-active member sees that they are a member
   * rather than a buy button", which the web can only do if the profile says
   * so. The projection stays CLOSED — exactly `tiers`, `viewerIsMember`,
   * `viewerMembershipEnded` and `viewerRequestPending`, nothing else: this
   * endpoint is public, and all three booleans are about the caller, not
   * about the creator being viewed.
   */
  it("carries the standing through as two booleans, and adds nothing else to the projection", () => {
    const member = toMembershipView([tierRow()], "member", null);
    expect(member.viewerIsMember).toBe(true);
    expect(member.viewerMembershipEnded).toBe(false);
    expect(Object.keys(member).sort()).toEqual([
      "tiers",
      "viewerIsMember",
      "viewerMembershipEnded",
      "viewerRequestPending",
    ]);

    const stranger = toMembershipView([tierRow()], "none", null);
    expect(stranger.viewerIsMember).toBe(false);
    expect(stranger.viewerMembershipEnded).toBe(false);
    expect("viewerIsMember" in stranger).toBe(true);
    expect("viewerMembershipEnded" in stranger).toBe(true);
  });

  /**
   * **THE STATE EVERY PAYING MEMBER REACHES**, and the one a single boolean
   * could not express. The two booleans must be the OPPOSITE way round from a
   * live member, and they must never both be true — the profile would then
   * claim both things about the same person on the same page.
   */
  it("a LAPSED standing is not a member, and is not the same as a stranger", () => {
    const lapsed = toMembershipView([tierRow()], "lapsed", null);

    expect(lapsed.viewerIsMember).toBe(false);
    expect(lapsed.viewerMembershipEnded).toBe(true);

    const stranger = toMembershipView([tierRow()], "none", null);
    expect(stranger.viewerMembershipEnded).toBe(false);
    // The distinction, stated as the thing that must not collapse: these two
    // people read different sentences, and the boolean that separates them is
    // this one.
    expect(lapsed.viewerMembershipEnded).not.toBe(stranger.viewerMembershipEnded);

    // Never both. `MembershipStanding` is one value, so this is structural
    // rather than a rule a caller has to keep.
    expect(lapsed.viewerIsMember && lapsed.viewerMembershipEnded).toBe(false);
  });

  /**
   * **THE SERVER HALF OF THE FINAL WHOLE-BRANCH REVIEW'S C-1.** Phase 5b's
   * headline feature is that a lapsed member can buy again — `retireExpired`
   * runs inside the purchase transaction, frees `user_subscription_one_active`'s
   * slot and lets the same tap open a fresh invoice, with no worker pass in
   * between. That feature is reachable only if this projection hands the lapsed
   * viewer the OFFER as well as the news: `MembershipOffer` cannot render a
   * "Jadi anggota" button for a tier it was never sent.
   *
   * So a lapsed viewer's `tiers` must be byte-for-byte what a stranger's is.
   * The one thing that differs between the two of them is the SENTENCE, and
   * that is `viewerMembershipEnded`'s whole remaining job.
   */
  it("still carries the full offer to a LAPSED viewer — identical tiers to a stranger's", () => {
    const rows = [tierRow({ id: "tier-1", name: "Perak" }), tierRow({ id: "tier-2", name: "Emas" })];
    const lapsed = toMembershipView(rows, "lapsed", null);
    const stranger = toMembershipView(rows, "none", null);

    expect(lapsed.tiers).toEqual([
      { id: "tier-1", name: "Perak", priceAmount: 50_000, billingCycle: "monthly" },
      { id: "tier-2", name: "Emas", priceAmount: 50_000, billingCycle: "monthly" },
    ]);
    expect(lapsed.tiers).toEqual(stranger.tiers);
    // And the flag that decides whether a button is offered at all reads the
    // same for both: neither of them is a member, and both may buy.
    expect(lapsed.viewerIsMember).toBe(false);
    expect(stranger.viewerIsMember).toBe(false);
  });

  /**
   * The refusal that MUST still be expressible. A viewer still inside their
   * paid period is `member`, and `StartUserSubscription` genuinely refuses them
   * a second purchase (`retireExpired`'s `current_period_end <= now` does not
   * touch a live row, so the status-only guard still sees it). C-1 opened the
   * button for `lapsed` only; if `viewerIsMember` ever stopped separating the
   * two, the profile would offer a purchase the route answers 409 to — the
   * non-terminating loop 5a shipped, rebuilt.
   */
  it("a LIVE member is still the only standing that reports viewerIsMember", () => {
    expect(toMembershipView([tierRow()], "member", null).viewerIsMember).toBe(true);
    expect(toMembershipView([tierRow()], "lapsed", null).viewerIsMember).toBe(false);
    expect(toMembershipView([tierRow()], "none", null).viewerIsMember).toBe(false);
    // ...and it is the ONE standing that is not also reported as ended.
    expect(toMembershipView([tierRow()], "member", null).viewerMembershipEnded).toBe(false);
  });

  /**
   * A member of a creator who has since withdrawn every tier: no offer left to
   * show, and still a member. The two halves are independent, and neither is
   * derived from the other.
   */
  it("an empty tier list and viewerIsMember: true are not contradictory", () => {
    const view = toMembershipView([], "member", null);

    expect(view.tiers).toEqual([]);
    expect(view.viewerIsMember).toBe(true);
  });

  /**
   * Task 6 of "free memberships". `pending` is `null` for the overwhelming
   * majority of calls (anonymous, self-view, no request) and this is the
   * default every other test above relies on implicitly — stated explicitly
   * once here rather than repeated on every call site.
   */
  it("viewerRequestPending is false when there is no pending row at all", () => {
    expect(toMembershipView([tierRow()], "none", null).viewerRequestPending).toBe(false);
  });

  /**
   * **THE CASE THIS TASK EXISTS FOR.** A free request, freshly claimed by
   * `StartUserSubscription`'s free path (`claimPending({ ..., kind: "free"
   * })`) and not yet decided by the owner — `status: "pending"`,
   * `kind: "free"`. The web needs this to say "your request is awaiting
   * approval" instead of re-offering a tier the viewer already asked for.
   */
  it("viewerRequestPending is TRUE for a free pending row", () => {
    const view = toMembershipView([tierRow()], "none", pendingRow({ kind: "free" }));
    expect(view.viewerRequestPending).toBe(true);
  });

  /**
   * **THE RULING THIS TASK'S BRIEF SPELLS OUT.** A PAID pending checkout —
   * an open Xendit invoice — is a DIFFERENT state from a free request
   * awaiting the owner. That person is mid-payment, not waiting on anybody's
   * approval, and `viewerRequestPending: true` here would be a lie told to
   * exactly the person in the middle of paying. `findPendingFor`'s read is
   * kind-agnostic on purpose (its own port docstring); this is where the
   * free-only judgement actually lives.
   */
  it("viewerRequestPending is FALSE for a PAID pending checkout — a different state, not a lie to a paying viewer", () => {
    const view = toMembershipView([tierRow()], "none", pendingRow({ kind: "paid" }));
    expect(view.viewerRequestPending).toBe(false);
  });

  /**
   * An ACTIVE membership (already approved, or a live paid subscription) is
   * no longer pending — `pending` itself would be `null` by the time this
   * function is called, since `findPendingFor` only ever returns `status =
   * 'pending'` rows, but this pins the projection's own behaviour should a
   * caller ever hand it something stale: only a genuinely pending row can
   * make this true.
   */
  it("viewerRequestPending is false when pending is null, regardless of standing", () => {
    expect(toMembershipView([tierRow()], "member", null).viewerRequestPending).toBe(false);
    expect(toMembershipView([tierRow()], "lapsed", null).viewerRequestPending).toBe(false);
  });

  /**
   * `viewerIsMember`/`viewerMembershipEnded` and `viewerRequestPending` are
   * independent fields on one object — nothing here derives one from the
   * other, so a free pending request can coexist with any standing the
   * caller happens to pass (in practice `"none"`, since a signed-in viewer
   * with a live or lapsed membership to this owner cannot also hold a
   * pending row to the SAME owner — but that exclusion lives in the
   * database's constraints, not in this pure function).
   */
  it("viewerRequestPending does not depend on standing", () => {
    const view = toMembershipView([tierRow()], "lapsed", pendingRow({ kind: "free" }));
    expect(view.viewerRequestPending).toBe(true);
    expect(view.viewerMembershipEnded).toBe(true);
  });
});
