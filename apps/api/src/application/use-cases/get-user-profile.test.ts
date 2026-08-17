import { describe, expect, it } from "bun:test";
import { GetUserProfile } from "./get-user-profile";
import { NotFoundError } from "../errors";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type {
  FollowCounts,
  FollowListRow,
  FollowRepositoryPort,
} from "../ports/follow-repository.port";

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

describe("GetUserProfile.execute (public, by handle)", () => {
  it("returns EXACTLY handle/displayName/bio/createdAt/followerCount/followingCount/viewerFollows — no email, whatsappNumber, id or sessionEpoch", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({ counts: { followers: 3, following: 5 } })
    );
    const profile = await useCase.execute("wildan", null);

    expect(Object.keys(profile).sort()).toEqual([
      "bio",
      "createdAt",
      "displayName",
      "followerCount",
      "followingCount",
      "handle",
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
    });
  });

  it("viewerFollows is null for an anonymous viewer — not false", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}));
    const profile = await useCase.execute("wildan", null);
    expect(profile.viewerFollows).toBeNull();
  });

  it("viewerFollows is true when the signed-in viewer already follows the target", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record()]),
      fakeFollowRepository({ followingPairs: [["viewer-1", "user-1"]] })
    );
    const profile = await useCase.execute("wildan", "viewer-1");
    expect(profile.viewerFollows).toBe(true);
  });

  it("viewerFollows is false when the signed-in viewer does not follow the target", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}));
    const profile = await useCase.execute("wildan", "viewer-1");
    expect(profile.viewerFollows).toBe(false);
  });

  it("normalises a leading @ before looking the handle up", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}));
    const profile = await useCase.execute("@wildan", null);
    expect(profile.handle).toBe("wildan");
  });

  it("404s for an unknown handle", async () => {
    const useCase = new GetUserProfile(fakeRepository([]), fakeFollowRepository({}));
    await expect(useCase.execute("nobody", null)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("bio: null projects as null, not omitted or undefined", async () => {
    const useCase = new GetUserProfile(
      fakeRepository([record({ bio: null })]),
      fakeFollowRepository({})
    );
    const profile = await useCase.execute("wildan", null);
    expect(profile.bio).toBeNull();
    expect("bio" in profile).toBe(true);
  });
});

describe("GetUserProfile.executeOwn (authenticated, by id)", () => {
  it("returns the public core fields PLUS email and whatsappNumber — no follower counts or viewerFollows", async () => {
    const useCase = new GetUserProfile(fakeRepository([record()]), fakeFollowRepository({}));
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

  it("404s for an id that does not exist", async () => {
    const useCase = new GetUserProfile(fakeRepository([]), fakeFollowRepository({}));
    await expect(useCase.executeOwn("ghost")).rejects.toBeInstanceOf(NotFoundError);
  });
});
