import { describe, expect, it } from "bun:test";
import { assertValidTier, createMembershipTier } from "./membership-tier";

describe("createMembershipTier", () => {
  it("creates a valid tier, defaulting isActive to true", () => {
    const tier = createMembershipTier({
      id: "tier-1",
      communityId: "community-1",
      name: "Basic",
      priceAmount: 50000,
      billingCycle: "monthly",
    });

    expect(tier.isActive).toBe(true);
    expect(tier.priceAmount).toBe(50000);
  });

  it("rejects a negative priceAmount", () => {
    expect(() =>
      createMembershipTier({
        id: "tier-1",
        communityId: "community-1",
        name: "Basic",
        priceAmount: -1000,
        billingCycle: "monthly",
      })
    ).toThrow("priceAmount must not be negative");
  });

  it("rejects an empty name", () => {
    expect(() =>
      createMembershipTier({
        id: "tier-1",
        communityId: "community-1",
        name: "   ",
        priceAmount: 50000,
        billingCycle: "monthly",
      })
    ).toThrow("name must not be empty");
  });
});

describe("assertValidTier", () => {
  it("accepts a valid tier", () => {
    expect(() =>
      assertValidTier({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    ).not.toThrow();
  });

  it("rejects a negative priceAmount", () => {
    expect(() =>
      assertValidTier({ name: "Basic", priceAmount: -1, billingCycle: "monthly" })
    ).toThrow("priceAmount must not be negative");
  });

  it("rejects an empty name", () => {
    expect(() =>
      assertValidTier({ name: "  ", priceAmount: 100, billingCycle: "monthly" })
    ).toThrow("name must not be empty");
  });
});
