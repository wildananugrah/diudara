import { describe, expect, it } from "bun:test";
import { GetUserProfile } from "./get-user-profile";
import { IsMemberOf } from "./is-member-of";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { NotFoundError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type {
  FollowCounts,
  FollowListRow,
  FollowRepositoryPort,
} from "../ports/follow-repository.port";
import type { UserTierRepositoryPort, UserTierRow } from "../ports/user-tier-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";

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

/**
 * The instant these tests stand at. A subscription's period end is placed
 * either side of it, never on it — the boundary itself is `IsMemberOf`'s own
 * suite's business.
 */
const NOW = new Date("2026-08-20T12:00:00.000Z");

/**
 * A fake `UserSubscriptionRepositoryPort` that answers exactly one question:
 * `findActiveFor`. Every other method throws — `GetUserProfile` has no
 * business calling one, and a fake that quietly returned `null` would hide a
 * profile read that started writing subscriptions.
 *
 * `rows` are ACTIVE rows keyed by (subscriber, owner); their
 * `currentPeriodEnd` is what decides whether the viewer is still a member.
 */
function fakeSubscriptions(
  rows: Array<{ subscriberId: string; ownerId: string; currentPeriodEnd: Date | null }>
): UserSubscriptionRepositoryPort {
  const notUsed = () => {
    throw new Error("not used in these tests");
  };
  return {
    create: notUsed,
    claimPending: notUsed,
    findById: notUsed,
    activate: notUsed,
    cancel: notUsed,
    async findActiveFor(subscriberId: string, ownerId: string): Promise<UserSubscriptionRow | null> {
      const row = rows.find((r) => r.subscriberId === subscriberId && r.ownerId === ownerId);
      if (!row) return null;
      return {
        id: "sub-1",
        subscriberId: row.subscriberId,
        tierId: "tier-1",
        ownerId: row.ownerId,
        // `findActiveFor` only ever returns ACTIVE rows — that scoping is the
        // real repository's contract (its own port docstring and
        // `drizzle-user-subscription.repository.test.ts`), trusted here the
        // same way `fakeUserTierRepository` trusts `listActiveByOwner`.
        status: "active",
        currentPeriodEnd: row.currentPeriodEnd,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      };
    },
    createTransaction: notUsed,
    findTransactionById: notUsed,
    attachGatewayReference: notUsed,
    findPendingCheckout: notUsed,
    markTransactionPaid: notUsed,
  } as unknown as UserSubscriptionRepositoryPort;
}

/**
 * **The REAL `IsMemberOf`, never a stub that says yes or no.**
 *
 * Task 10 injects that use-case rather than re-deriving membership here, and
 * these tests inject it too: a hand-written stub would let this file agree
 * that somebody is a member while `IsMemberOf` — the one thing Phase 6's
 * paywall will ask — says otherwise. Handing it a fake repository and a fixed
 * clock keeps the semantics (`status = 'active'` AND `current_period_end >
 * now`) genuinely in play, which is what makes the lapsed case below mean
 * anything.
 */
function membershipCheck(
  rows: Array<{ subscriberId: string; ownerId: string; currentPeriodEnd: Date | null }> = []
): IsMemberOf {
  return new IsMemberOf(fakeSubscriptions(rows), new FixedClock(NOW));
}

/** Nobody is a member of anybody — what most of these tests want. */
function noMembership(): IsMemberOf {
  return membershipCheck([]);
}

describe("GetUserProfile.execute (public, by handle)", () => {
  it("returns EXACTLY handle/displayName/bio/createdAt/followerCount/followingCount/viewerFollows/membership — no email, whatsappNumber, id or sessionEpoch", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({ counts: { followers: 3, following: 5 } }),
      fakeUserTierRepository([tierRow()])
    ,
      noMembership()
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
        viewerIsMember: false,
      },
    });
  });

  it("viewerFollows is null for an anonymous viewer — not false", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
    );
    const profile = await useCase.execute("wildan", null);
    expect(profile.viewerFollows).toBeNull();
  });

  it("viewerFollows is true when the signed-in viewer already follows the target", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({ followingPairs: [["viewer-1", "user-1"]] }),
      fakeUserTierRepository([])
    ,
      noMembership()
    );
    const profile = await useCase.execute("wildan", "viewer-1");
    expect(profile.viewerFollows).toBe(true);
  });

  it("viewerFollows is false when the signed-in viewer does not follow the target", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
    );
    const profile = await useCase.execute("wildan", "viewer-1");
    expect(profile.viewerFollows).toBe(false);
  });

  it("normalises a leading @ before looking the handle up", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
    );
    const profile = await useCase.execute("@wildan", null);
    expect(profile.handle).toBe("wildan");
  });

  it("404s for an unknown handle", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
    );
    await expect(useCase.execute("nobody", null)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("bio: null projects as null, not omitted or undefined", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record({ bio: null })]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
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
    ,
      noMembership()
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
    ,
      noMembership()
    );
    const profile = await useCase.execute("wildan", null);

    expect("membership" in profile).toBe(true);
    expect(profile.membership).toEqual({ tiers: [], viewerIsMember: false });
  });

  it("fetches this owner's tiers in a SINGLE listActiveByOwner call, scoped to the profile's own id", async () => {
    const tiers = fakeUserTierRepository([tierRow(), tierRow({ id: "tier-2" })]);
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}), tiers, noMembership());

    await useCase.execute("wildan", null);

    expect(tiers.listActiveByOwnerCalls).toEqual(["user-1"]);
  });
});

/**
 * Task 10 of Phase 5a (spec §6): "an already-active member sees that they are
 * a member rather than a buy button". The web cannot know that on its own —
 * nothing else on this endpoint is viewer-specific except `viewerFollows` —
 * so the profile carries the answer, and it comes from `IsMemberOf`, the same
 * use-case Phase 6's paywall is founded on.
 */
describe("GetUserProfile.execute — viewerIsMember (Task 10)", () => {
  const FUTURE = new Date("2026-09-20T00:00:00.000Z"); // after NOW
  const PAST = new Date("2026-08-01T00:00:00.000Z"); // before NOW

  it("is FALSE — never null — for a signed-out visitor", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([tierRow()]),
      // A membership that WOULD match if this viewer were signed in: the
      // anonymous answer must not depend on what is in the table.
      membershipCheck([{ subscriberId: "viewer-1", ownerId: "user-1", currentPeriodEnd: FUTURE }])
    );

    const profile = await useCase.execute("wildan", null);

    expect(profile.membership.viewerIsMember).toBe(false);
    // Its neighbour IS tri-state, deliberately — see the field's own
    // docstring for why these two disagree.
    expect(profile.viewerFollows).toBeNull();
  });

  it("is true for a signed-in viewer whose active membership has not run out", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([tierRow()]),
      membershipCheck([{ subscriberId: "viewer-1", ownerId: "user-1", currentPeriodEnd: FUTURE }])
    );

    const profile = await useCase.execute("wildan", "viewer-1");

    expect(profile.membership.viewerIsMember).toBe(true);
    // The offer is still listed: what the creator sells does not depend on
    // who is looking. The WEB decides not to show a buy button.
    expect(profile.membership.tiers).toHaveLength(1);
  });

  it("is false for a signed-in viewer who never subscribed", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([tierRow()]),
      membershipCheck([{ subscriberId: "somebody-else", ownerId: "user-1", currentPeriodEnd: FUTURE }])
    );

    const profile = await useCase.execute("wildan", "viewer-1");

    expect(profile.membership.viewerIsMember).toBe(false);
  });

  /**
   * **THE CASE THAT WOULD SILENTLY REGRESS.** §9: 5a has no renewal pass, so
   * nothing ever moves a subscription out of `active` when its period ends —
   * a row can sit at `status = 'active'` with `current_period_end` long in the
   * past. Anything that read the status alone would call that person a member
   * FOREVER, and they would never be offered the membership again. The period
   * check is not a defensive extra; it is the point.
   */
  it("is FALSE for a lapsed membership — status is still active, the period is not", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([tierRow()]),
      membershipCheck([{ subscriberId: "viewer-1", ownerId: "user-1", currentPeriodEnd: PAST }])
    );

    const profile = await useCase.execute("wildan", "viewer-1");

    expect(profile.membership.viewerIsMember).toBe(false);
    // ...and the offer is right there to buy again, which is 5a being honest
    // about having no renewal rather than pretending to have one.
    expect(profile.membership.tiers).toHaveLength(1);
  });

  it("is false on your OWN profile — nobody is a member of themselves", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([tierRow()]),
      membershipCheck([{ subscriberId: "user-1", ownerId: "user-1", currentPeriodEnd: FUTURE }])
    );

    const profile = await useCase.execute("wildan", "user-1");

    expect(profile.membership.viewerIsMember).toBe(false);
  });
});

describe("GetUserProfile.executeOwn (authenticated, by id)", () => {
  it("returns the public core fields PLUS email and whatsappNumber — no follower counts, viewerFollows or membership", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
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
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}), tiers, noMembership());

    await expect(useCase.executeOwn("user-1")).resolves.toBeDefined();
  });

  it("404s for an id that does not exist", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([]),
      fakeFollowRepository({}),
      fakeUserTierRepository([])
    ,
      noMembership()
    );
    await expect(useCase.executeOwn("ghost")).rejects.toBeInstanceOf(NotFoundError);
  });
});
