import { describe, expect, it } from "bun:test";
import { DEFAULT_FOLLOW_LIST_LIMIT, FollowUser, ListFollows } from "./follow-user";
import { ConflictError, NotFoundError } from "../errors";
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
    whatsappNumber: null,
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeUserRepository(rows: UserRecord[]): UserRepositoryPort {
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

/**
 * An in-memory stand-in for `FollowRepositoryPort` — NOT a re-implementation
 * of `DrizzleFollowRepository`'s guarantees (the unique-index idempotency,
 * the CHECK/FK backstops) — those are proven against a real Postgres in
 * `drizzle-follow.repository.test.ts`. This fake exists only to prove
 * `FollowUser`/`ListFollows` call the port correctly: idempotent
 * follow/unfollow, and that neither ever reaches `follow()`/`unfollow()`
 * with a self-follow or an unresolved handle, which is the whole point of
 * this use case.
 */
class FakeFollowRepository implements FollowRepositoryPort {
  private rows = new Set<string>();
  followCallCount = 0;
  unfollowCallCount = 0;
  private listing = new Map<string, FollowListRow[]>();

  private static key(followerId: string, followeeId: string): string {
    return `${followerId}:${followeeId}`;
  }

  /** Test setup only — seeds what `listFollowers`/`listFollowing` return for a given user id, bypassing the join `follow()` alone cannot express. */
  seedListing(userId: string, rows: FollowListRow[]): void {
    this.listing.set(userId, rows);
  }

  async follow(followerId: string, followeeId: string): Promise<boolean> {
    this.followCallCount += 1;
    const key = FakeFollowRepository.key(followerId, followeeId);
    if (this.rows.has(key)) return false;
    this.rows.add(key);
    return true;
  }

  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    this.unfollowCallCount += 1;
    const key = FakeFollowRepository.key(followerId, followeeId);
    if (!this.rows.has(key)) return false;
    this.rows.delete(key);
    return true;
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return this.rows.has(FakeFollowRepository.key(followerId, followeeId));
  }

  async countsFor(userId: string): Promise<FollowCounts> {
    let followers = 0;
    let following = 0;
    for (const key of this.rows) {
      const [follower, followee] = key.split(":");
      if (followee === userId) followers += 1;
      if (follower === userId) following += 1;
    }
    return { followers, following };
  }

  async listFollowers(userId: string, limit: number): Promise<FollowListRow[]> {
    return (this.listing.get(userId) ?? []).slice(0, limit);
  }

  async listFollowing(userId: string, limit: number): Promise<FollowListRow[]> {
    return (this.listing.get(userId) ?? []).slice(0, limit);
  }

  get rowCount(): number {
    return this.rows.size;
  }
}

describe("FollowUser.execute", () => {
  it("follow returns { following: true }", async () => {
    const users = fakeUserRepository([record(), record({ id: "user-2", handle: "rina" })]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    const result = await useCase.execute({ followerId: "user-1", handle: "rina", action: "follow" });
    expect(result).toEqual({ following: true });
  });

  it("following again returns the same state and creates no second row", async () => {
    const users = fakeUserRepository([record(), record({ id: "user-2", handle: "rina" })]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    const first = await useCase.execute({ followerId: "user-1", handle: "rina", action: "follow" });
    const second = await useCase.execute({ followerId: "user-1", handle: "rina", action: "follow" });

    expect(first).toEqual({ following: true });
    expect(second).toEqual({ following: true });
    expect(follows.rowCount).toBe(1);
    expect(follows.followCallCount).toBe(2);
  });

  it("unfollow returns { following: false }", async () => {
    const users = fakeUserRepository([record(), record({ id: "user-2", handle: "rina" })]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    await useCase.execute({ followerId: "user-1", handle: "rina", action: "follow" });
    const result = await useCase.execute({ followerId: "user-1", handle: "rina", action: "unfollow" });

    expect(result).toEqual({ following: false });
    expect(follows.rowCount).toBe(0);
  });

  it("unfollowing someone you never followed returns the same state, no error", async () => {
    const users = fakeUserRepository([record(), record({ id: "user-2", handle: "rina" })]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    const result = await useCase.execute({ followerId: "user-1", handle: "rina", action: "unfollow" });
    expect(result).toEqual({ following: false });
    expect(follows.unfollowCallCount).toBe(1);
  });

  it("404s for an unknown handle", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    await expect(
      useCase.execute({ followerId: "user-1", handle: "nobody", action: "follow" })
    ).rejects.toBeInstanceOf(NotFoundError);
    // Never reached `follow()` with an unresolved target — the whole point
    // of resolving the handle BEFORE calling the port (see the class docstring).
    expect(follows.followCallCount).toBe(0);
  });

  it("following yourself 409s with the exact Indonesian message, and never reaches the repository", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    const attempt = useCase.execute({ followerId: "user-1", handle: "wildan", action: "follow" });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(attempt.catch((e: Error) => e.message)).resolves.toBe(
      "tidak bisa mengikuti akun sendiri"
    );
    // THE precondition this class exists to enforce: the raw 23514 self-follow
    // CHECK violation must never be reachable through this use case.
    expect(follows.followCallCount).toBe(0);
  });

  it("unfollowing yourself also 409s, before ever reaching the repository", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    await expect(
      useCase.execute({ followerId: "user-1", handle: "wildan", action: "unfollow" })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(follows.unfollowCallCount).toBe(0);
  });

  it("a handle sent with a leading @ still resolves", async () => {
    const users = fakeUserRepository([record(), record({ id: "user-2", handle: "rina" })]);
    const follows = new FakeFollowRepository();
    const useCase = new FollowUser(users, follows);

    const result = await useCase.execute({ followerId: "user-1", handle: "@rina", action: "follow" });
    expect(result).toEqual({ following: true });
  });
});

describe("ListFollows.execute", () => {
  function followRow(overrides: Partial<FollowListRow> = {}): FollowListRow {
    return { handle: "member", displayName: "Member", bio: null, ...overrides };
  }

  it("404s for an unknown handle", async () => {
    const users = fakeUserRepository([]);
    const useCase = new ListFollows(users, new FakeFollowRepository());

    await expect(
      useCase.execute({ handle: "nobody", direction: "followers" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("defaults the limit to 50 when none is given", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    const many = Array.from({ length: 60 }, (_, i) => followRow({ handle: `f${i}` }));
    follows.seedListing("user-1", many);
    const useCase = new ListFollows(users, follows);

    const rows = await useCase.execute({ handle: "wildan", direction: "followers" });
    expect(rows).toHaveLength(DEFAULT_FOLLOW_LIST_LIMIT);
  });

  it("forwards an explicit limit to the repository", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    follows.seedListing("user-1", Array.from({ length: 10 }, (_, i) => followRow({ handle: `f${i}` })));
    const useCase = new ListFollows(users, follows);

    const rows = await useCase.execute({ handle: "wildan", direction: "followers", limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it("reads the following direction from a separate listing than followers", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    follows.seedListing("user-1", [followRow({ handle: "same-source" })]);
    const useCase = new ListFollows(users, follows);

    const followers = await useCase.execute({ handle: "wildan", direction: "followers" });
    const following = await useCase.execute({ handle: "wildan", direction: "following" });
    expect(followers).toHaveLength(1);
    expect(following).toHaveLength(1);
  });

  it("a handle sent with a leading @ still resolves", async () => {
    const users = fakeUserRepository([record()]);
    const follows = new FakeFollowRepository();
    follows.seedListing("user-1", [followRow()]);
    const useCase = new ListFollows(users, follows);

    const rows = await useCase.execute({ handle: "@wildan", direction: "followers" });
    expect(rows).toHaveLength(1);
  });
});
