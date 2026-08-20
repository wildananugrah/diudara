import { describe, expect, it } from "bun:test";
import { GetUserProfile } from "./get-user-profile";
import { NotFoundError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type {
  FollowCounts,
  FollowListRow,
  FollowRepositoryPort,
} from "../ports/follow-repository.port";
import type { UserTierRepositoryPort, UserTierRow } from "../ports/user-tier-repository.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: "+6281234567890",
    displayName: "Wildan",
    bio: "Building DIUDARA",
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeRepository(rows: UserRecord[]): UserRepositoryPort {
  return {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHandle(handle) {
      return rows.find((r) => r.handle === handle) ?? null;
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail() {
      throw new Error("not used in these tests");
    },
    async findCredentialsByEmail() {
      throw new Error("not used in these tests");
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
    async searchPublic() {
      throw new Error("not used in these tests");
    },
    async newestPublic() {
      throw new Error("not used in these tests");
    },
    async mostFollowedPublic() {
      throw new Error("not used in these tests");
    },
  };
}

/** A minimal fake `FollowRepositoryPort`: fixed counts, and following driven by an explicit set of (viewerId, targetId) pairs. */
function fakeFollowRepository(options: {
  counts?: FollowCounts;
  followingPairs?: Array<[string, string]>;
}): FollowRepositoryPort {
  const counts = options.counts ?? { followers: 0, following: 0 };
  const followingPairs = options.followingPairs ?? [];
  return {
    async follow() {
      throw new Error("not used in these tests");
    },
    async unfollow() {
      throw new Error("not used in these tests");
    },
    async followedHandlesAmong() {
      // `GetUserProfile` reads a SINGLE profile and asks `isFollowing`; the
      // batch lookup belongs to the three LIST endpoints (`ListFollows`,
      // `ExploreUsers`). Throwing rather than returning `[]` so a future change
      // that starts routing a profile read through the batch path shows up here
      // instead of silently answering "follows nobody".
      throw new Error("not used in these tests");
    },
    async isFollowing(followerId, followeeId) {
      return followingPairs.some(([f, t]) => f === followerId && t === followeeId);
    },
    async countsFor() {
      return counts;
    },
    async listFollowers(): Promise<FollowListRow[]> {
      throw new Error("not used in these tests");
    },
    async listFollowing(): Promise<FollowListRow[]> {
      throw new Error("not used in these tests");
    },
  };
}

function tierRow(overrides: Partial<UserTierRow> = {}): UserTierRow {
  return {
    id: "tier-1",
    ownerId: "user-1",
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
    isActive: true,
    createdAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

/**
 * A minimal fake `UserTierRepositoryPort`. `rows` is exactly what
 * `listActiveByOwner` returns — this fake does not re-filter by
 * `isActive`/`ownerId` itself, the same way `fakeFollowRepository` above
 * returns fixed counts rather than recomputing them: that scoping is the
 * REAL repository's contract (pinned by `drizzle-user-tier.repository.test.ts`
 * and the port's own docstring), not something `GetUserProfile` re-derives.
 *
 * `listActiveByOwnerCalls` records every call, so Task 5's "one query, not
 * one per tier" requirement can be asserted directly rather than inferred
 * from the output. `findById`/`listByOwner`/`create`/`deactivate` all throw —
 * `GetUserProfile` has no business calling any of them.
 */
function fakeUserTierRepository(rows: UserTierRow[]): UserTierRepositoryPort & {
  listActiveByOwnerCalls: string[];
} {
  const listActiveByOwnerCalls: string[] = [];
  return {
    listActiveByOwnerCalls,
    async create() {
      throw new Error("not used in these tests");
    },
    async findById() {
      throw new Error("not used in these tests");
    },
    async listByOwner() {
      throw new Error("not used in these tests — the public profile reads listActiveByOwner");
    },
    async listActiveByOwner(ownerId) {
      listActiveByOwnerCalls.push(ownerId);
      return rows;
    },
    async deactivate() {
      throw new Error("not used in these tests");
    },
  };
}

describe("GetUserProfile.execute (public, by handle)", () => {
  it("returns EXACTLY handle/displayName/bio/createdAt/followerCount/followingCount/viewerFollows/membership — no email, whatsappNumber, id or sessionEpoch", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({ counts: { followers: 3, following: 5 } }),
      fakeUserTierRepository([tierRow()])
    );
    const profile = await useCase.execute("wildan", null);

    expect(Object.keys(profile).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "followerCount",
      "followingCount",
      "handle",
      "membership",
      "viewerFollows",
    ]);
    expect(profile).toEqual({
      handle: "wildan",
      displayName: "Wildan",
      bio: "Building DIUDARA",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      followerCount: 3,
      followingCount: 5,
      viewerFollows: null,
      membership: {
        tiers: [
          { id: "tier-1", name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" },
        ],
      },
    });
  });

  it("viewerFollows is null for an anonymous viewer — not false", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    const profile = await useCase.execute("wildan", null);
    expect(profile.viewerFollows).toBeNull();
  });

  it("viewerFollows is true when the signed-in viewer already follows the target", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({ followingPairs: [["viewer-1", "user-1"]] }),
      fakeUserTierRepository([])
    );
    const profile = await useCase.execute("wildan", "viewer-1");
    expect(profile.viewerFollows).toBe(true);
  });

  it("viewerFollows is false when the signed-in viewer does not follow the target", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    const profile = await useCase.execute("wildan", "viewer-1");
    expect(profile.viewerFollows).toBe(false);
  });

  it("normalises a leading @ before looking the handle up", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    const profile = await useCase.execute("@wildan", null);
    expect(profile.handle).toBe("wildan");
  });

  it("404s for an unknown handle", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    await expect(useCase.execute("nobody", null)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("bio: null projects as null, not omitted or undefined", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record({ bio: null })]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    const profile = await useCase.execute("wildan", null);
    expect(profile.bio).toBeNull();
    expect("bio" in profile).toBe(true);
  });
});

/**
 * Task 5 (memberships-5a spec §6): the offer on a profile. Three behaviours
 * the brief calls out as easy to get subtly wrong — closed keys per tier,
 * an empty list rather than an omitted field, and one query rather than one
 * per tier. Active-vs-inactive scoping itself is `listActiveByOwner`'s own
 * contract (proved against a real database in
 * `drizzle-user-tier.repository.test.ts` and end-to-end in
 * `routes/users.test.ts`); this fake trusts that contract the same way
 * `fakeFollowRepository` above trusts `countsFor`.
 */
describe("GetUserProfile.execute — membership (Task 5)", () => {
  it("a tier on the wire is EXACTLY id/name/priceAmount/billingCycle — never ownerId, isActive or createdAt", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([tierRow()])
    );
    const profile = await useCase.execute("wildan", null);

    expect(profile.membership.tiers).toHaveLength(1);
    expect(Object.keys(profile.membership.tiers[0]!).sort()).toEqual([
      "billingCycle",
      "id",
      "name",
      "priceAmount",
    ]);
  });

  it("a profile with no tiers reports membership: { tiers: [] }, not an omitted field", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    const profile = await useCase.execute("wildan", null);

    expect("membership" in profile).toBe(true);
    expect(profile.membership).toEqual({ tiers: [] });
  });

  it("fetches this owner's tiers in a SINGLE listActiveByOwner call, scoped to the profile's own id", async () => {
    const tiers = fakeUserTierRepository([tierRow(), tierRow({ id: "tier-2" })]);
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}), tiers);

    await useCase.execute("wildan", null);

    expect(tiers.listActiveByOwnerCalls).toEqual(["user-1"]);
  });
});

describe("GetUserProfile.executeOwn (authenticated, by id)", () => {
  it("returns the public core fields PLUS email and whatsappNumber — no follower counts, viewerFollows or membership", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    const profile = await useCase.executeOwn("user-1");

    expect(Object.keys(profile).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "email",
      "handle",
      "whatsappNumber",
    ]);
    expect(profile.email).toBe("wildan@example.com");
    expect(profile.whatsappNumber).toBe("+6281234567890");
  });

  it("never touches the tier repository — GET /users/me is not the public offer", async () => {
    const tiers: UserTierRepositoryPort = {
      async create() {
        throw new Error("must not be called");
      },
      async findById() {
        throw new Error("must not be called");
      },
      async listByOwner() {
        throw new Error("must not be called");
      },
      async listActiveByOwner() {
        throw new Error("must not be called");
      },
      async deactivate() {
        throw new Error("must not be called");
      },
    };
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}), tiers);

    await expect(useCase.executeOwn("user-1")).resolves.toBeDefined();
  });

  it("404s for an id that does not exist", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    );
    await expect(useCase.executeOwn("ghost")).rejects.toBeInstanceOf(NotFoundError);
  });
});
