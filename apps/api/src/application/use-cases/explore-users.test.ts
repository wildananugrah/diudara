import { describe, expect, it } from "bun:test";
import { DEFAULT_EXPLORE_LIMIT, ExploreUsers } from "./explore-users";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { FollowListRow } from "../ports/follow-repository.port";

function row(handle: string): FollowListRow {
  return { handle, displayName: handle, bio: null };
}

/**
 * An in-memory stand-in for `UserRepositoryPort` — NOT a re-implementation of
 * `DrizzleUserRepository`'s query guarantees (those are proven against a real
 * Postgres in `drizzle-user.repository.test.ts`). This fake exists only to
 * prove `ExploreUsers` calls the three read methods correctly: which ones
 * fire, with what arguments, and what shape comes back out.
 */
class FakeUserRepository implements UserRepositoryPort {
  searchCalls: Array<{ query: string; limit: number }> = [];
  newestCalls: number[] = [];
  mostFollowedCalls: number[] = [];

  constructor(
    private readonly searchRows: FollowListRow[] = [],
    private readonly newestRows: FollowListRow[] = [],
    private readonly mostFollowedRows: FollowListRow[] = []
  ) {}

  async create(): Promise<UserRecord> {
    throw new Error("not used in these tests");
  }
  async findByHandle(): Promise<UserRecord | null> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<UserRecord | null> {
    throw new Error("not used in these tests");
  }
  async findByEmail(): Promise<UserRecord | null> {
    throw new Error("not used in these tests");
  }
  async findCredentialsByEmail(): Promise<null> {
    throw new Error("not used in these tests");
  }
  async updateProfile(): Promise<UserRecord | null> {
    throw new Error("not used in these tests");
  }
  async setPasswordAndBumpEpoch(): Promise<boolean> {
    throw new Error("not used in these tests");
  }

  async searchPublic(query: string, limit: number): Promise<FollowListRow[]> {
    this.searchCalls.push({ query, limit });
    return this.searchRows;
  }
  async newestPublic(limit: number): Promise<FollowListRow[]> {
    this.newestCalls.push(limit);
    return this.newestRows;
  }
  async mostFollowedPublic(limit: number): Promise<FollowListRow[]> {
    this.mostFollowedCalls.push(limit);
    return this.mostFollowedRows;
  }
}

describe("ExploreUsers", () => {
  it("with no q: returns empty results but still returns both newest and mostFollowed", async () => {
    const users = new FakeUserRepository([row("shouldnotappear")], [row("newbie")], [row("famous")]);
    const useCase = new ExploreUsers(users);

    const result = await useCase.execute({});

    expect(result.results).toEqual([]);
    expect(result.newest).toEqual([row("newbie")]);
    expect(result.mostFollowed).toEqual([row("famous")]);
    // The default state of the screen, not a search — searchPublic must not
    // even be called when there is nothing to search for.
    expect(users.searchCalls).toHaveLength(0);
  });

  it("with a whitespace-only q: behaves identically to no q at all", async () => {
    const users = new FakeUserRepository([row("shouldnotappear")], [row("newbie")], [row("famous")]);
    const useCase = new ExploreUsers(users);

    const result = await useCase.execute({ q: "   " });

    expect(result.results).toEqual([]);
    expect(users.searchCalls).toHaveLength(0);
  });

  it("with a q: calls searchPublic with the trimmed query and returns its rows as results", async () => {
    const users = new FakeUserRepository([row("wildan")], [], []);
    const useCase = new ExploreUsers(users);

    const result = await useCase.execute({ q: "  wildan  " });

    expect(result.results).toEqual([row("wildan")]);
    expect(users.searchCalls).toEqual([{ query: "wildan", limit: DEFAULT_EXPLORE_LIMIT }]);
  });

  it("still returns newest and mostFollowed alongside a non-empty q", async () => {
    const users = new FakeUserRepository([row("wildan")], [row("newbie")], [row("famous")]);
    const useCase = new ExploreUsers(users);

    const result = await useCase.execute({ q: "wildan" });

    expect(result.newest).toEqual([row("newbie")]);
    expect(result.mostFollowed).toEqual([row("famous")]);
  });

  it("defaults the limit passed to all three reads when none is given", async () => {
    const users = new FakeUserRepository([], [], []);
    const useCase = new ExploreUsers(users);

    await useCase.execute({ q: "x" });

    expect(users.searchCalls[0]?.limit).toBe(DEFAULT_EXPLORE_LIMIT);
    expect(users.newestCalls[0]).toBe(DEFAULT_EXPLORE_LIMIT);
    expect(users.mostFollowedCalls[0]).toBe(DEFAULT_EXPLORE_LIMIT);
  });

  it("forwards an explicit limit to all three reads", async () => {
    const users = new FakeUserRepository([], [], []);
    const useCase = new ExploreUsers(users);

    await useCase.execute({ q: "x", limit: 7 });

    expect(users.searchCalls[0]?.limit).toBe(7);
    expect(users.newestCalls[0]).toBe(7);
    expect(users.mostFollowedCalls[0]).toBe(7);
  });
});
