import { describe, expect, it } from "bun:test";
import { GetPublicCommunity } from "./get-public-community";
import { NotFoundError } from "../errors";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";
import type {
  TierRecord,
  MembershipTierRepositoryPort,
} from "../ports/membership-tier-repository.port";

function community(overrides: Partial<CommunityRecord> = {}): CommunityRecord {
  return {
    id: "community-1",
    creatorId: "creator-1",
    name: "Kelas Bimbel Budi",
    slug: "kelas-bimbel-budi",
    niche: "bimbel",
    status: "active",
    accessMode: "paid",
    createdAt: new Date(0),
    ...overrides,
  };
}

function tier(overrides: Partial<TierRecord> = {}): TierRecord {
  return {
    id: "tier-1",
    communityId: "community-1",
    name: "Basic",
    priceAmount: 50000,
    billingCycle: "monthly",
    isActive: true,
    ...overrides,
  };
}

function useCase(
  row: CommunityRecord | null,
  tiers: TierRecord[] = [tier()],
  options: { paymentsEnabled?: boolean } = {}
) {
  const communities: CommunityRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByIdForCreator() {
      throw new Error("not used: the public page has no authenticated caller");
    },
    async listByCreator() {
      throw new Error("not used in these tests");
    },
    async slugExists() {
      throw new Error("not used in these tests");
    },
    async update() {
      throw new Error("not used in these tests");
    },
    async findBySlug(slug) {
      return row && row.slug === slug ? row : null;
    },
  };

  const membershipTiers: MembershipTierRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async listByCommunity() {
      return tiers;
    },
    async updateForCommunity() {
      throw new Error("not used in these tests");
    },
  };

  return new GetPublicCommunity(communities, membershipTiers, options);
}

/**
 * Spec §9.1 (ruled 2026-08-09). The original code said `status !== "active"`,
 * which collapsed `paused` into `archived`: a creator pausing for a holiday
 * would have told everyone holding an already-broadcast checkout link that the
 * community does not exist.
 */
describe("GetPublicCommunity status semantics", () => {
  it("renders an active community and accepts new members", async () => {
    const result = await useCase(community()).execute("kelas-bimbel-budi");
    expect(result.acceptingNewMembers).toBe(true);
    expect(result.name).toBe("Kelas Bimbel Budi");
  });

  it("renders a PAUSED community rather than 404-ing", async () => {
    const result = await useCase(community({ status: "paused" })).execute("kelas-bimbel-budi");
    expect(result.name).toBe("Kelas Bimbel Budi");
    expect(result.acceptingNewMembers).toBe(false);
  });

  it("404s an archived community", async () => {
    await expect(
      useCase(community({ status: "archived" })).execute("kelas-bimbel-budi")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an unknown slug", async () => {
    await expect(useCase(community()).execute("tidak-ada")).rejects.toBeInstanceOf(NotFoundError);
  });

  // `community.status` is a free varchar in the schema. A value nobody
  // anticipated must fail closed rather than publish the community by default.
  it("404s a status it does not recognise", async () => {
    await expect(
      useCase(community({ status: "suspended" })).execute("kelas-bimbel-budi")
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("still lists active tiers for a paused community", async () => {
    // The frontend needs the community's shape to render the closed state; it
    // is StartCheckout (Task 6) that must refuse, not this projection.
    const result = await useCase(community({ status: "paused" })).execute("kelas-bimbel-budi");
    expect(result.tiers.length).toBe(1);
  });

  it("never projects creatorId onto the public response", async () => {
    const result = await useCase(community({ status: "paused" })).execute("kelas-bimbel-budi");
    expect(JSON.stringify(result)).not.toContain("creator-1");
  });
});

/**
 * Task 3: `CheckoutPage` needs `accessMode` to decide between rendering a
 * purchase form and a join-request form, and `RequestToJoin` needs the SAME
 * value re-checked server-side — this is the one place both ultimately read
 * it from.
 */
describe("GetPublicCommunity — accessMode", () => {
  it("projects a paid community's accessMode verbatim", async () => {
    const result = await useCase(community({ accessMode: "paid" })).execute("kelas-bimbel-budi");
    expect(result.accessMode).toBe("paid");
  });

  it("projects a free community's accessMode verbatim", async () => {
    const result = await useCase(community({ accessMode: "request" })).execute(
      "kelas-bimbel-budi"
    );
    expect(result.accessMode).toBe("request");
  });
});

/**
 * A `paid` community on a box with NO payment provider had `acceptingNewMembers:
 * true`, so `CheckoutPage` rendered a price and a buy button whose checkout route
 * is not even registered — `POST /c/:slug/checkout` answers Hono's plain-text
 * `404 Not Found`, which the page surfaced as raw English `checkout failed (404)`.
 *
 * Design spec §2 is explicit that such a community must have "no join path at
 * all... It reads as 'not accepting new members right now.'"
 *
 * BLAST RADIUS is what makes this the phase's worst defect rather than a corner:
 * migration 0017 sets `access_mode = 'paid'` on EVERY pre-existing community, so
 * the first operator to run production without Xendit breaks every public
 * community page at once.
 */
describe("GetPublicCommunity — a paid community on a payments-disabled box", () => {
  it("refuses new members, so the page reads as 'not accepting' instead of offering a dead purchase", async () => {
    const result = await useCase(community({ accessMode: "paid" }), [tier()], {
      paymentsEnabled: false,
    }).execute("kelas-bimbel-budi");

    expect(result.acceptingNewMembers).toBe(false);
    // Still RENDERS — the page is not a 404, exactly like a paused community.
    expect(result.name).toBe("Kelas Bimbel Budi");
    expect(result.accessMode).toBe("paid");
  });

  it("leaves a REQUEST community accepting members on the same box — that is the whole point of the mode", async () => {
    const result = await useCase(community({ accessMode: "request" }), [tier()], {
      paymentsEnabled: false,
    }).execute("kelas-bimbel-budi");

    expect(result.acceptingNewMembers).toBe(true);
  });

  it("leaves a paid community accepting members when payments ARE configured", async () => {
    const result = await useCase(community({ accessMode: "paid" }), [tier()], {
      paymentsEnabled: true,
    }).execute("kelas-bimbel-budi");

    expect(result.acceptingNewMembers).toBe(true);
  });

  it("defaults to payments-enabled, so nothing changes for a box that never passes the option", async () => {
    const result = await useCase(community({ accessMode: "paid" })).execute("kelas-bimbel-budi");

    expect(result.acceptingNewMembers).toBe(true);
  });

  it("still refuses a PAUSED request-mode community — status and mode are separate reasons", async () => {
    const result = await useCase(community({ accessMode: "request", status: "paused" }), [tier()], {
      paymentsEnabled: false,
    }).execute("kelas-bimbel-budi");

    expect(result.acceptingNewMembers).toBe(false);
  });
});
