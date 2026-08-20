import { describe, expect, it } from "bun:test";
import type { UserTierRow } from "../ports/user-tier-repository.port";
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
      false
    );

    expect(Object.keys(view).sort()).toEqual(["tiers", "viewerIsMember"]);
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
    const view = toMembershipView([], false);

    expect("tiers" in view).toBe(true);
    expect(view.tiers).toEqual([]);
  });

  /**
   * Task 10 (spec §6): "an already-active member sees that they are a member
   * rather than a buy button", which the web can only do if the profile says
   * so. The projection stays CLOSED — exactly `tiers` and `viewerIsMember`,
   * nothing else: this endpoint is public, and the answer is about the caller,
   * not about the creator being viewed.
   */
  it("carries viewerIsMember through, both ways, and adds nothing else to the projection", () => {
    const member = toMembershipView([tierRow()], true);
    expect(member.viewerIsMember).toBe(true);
    expect(Object.keys(member).sort()).toEqual(["tiers", "viewerIsMember"]);

    const stranger = toMembershipView([tierRow()], false);
    expect(stranger.viewerIsMember).toBe(false);
    expect("viewerIsMember" in stranger).toBe(true);
  });

  /**
   * A member of a creator who has since withdrawn every tier: no offer left to
   * show, and still a member. The two halves are independent, and neither is
   * derived from the other.
   */
  it("an empty tier list and viewerIsMember: true are not contradictory", () => {
    const view = toMembershipView([], true);

    expect(view.tiers).toEqual([]);
    expect(view.viewerIsMember).toBe(true);
  });
});
