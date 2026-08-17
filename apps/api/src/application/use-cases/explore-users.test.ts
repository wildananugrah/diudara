import { describe, expect, it } from "bun:test";
import { DEFAULT_EXPLORE_LIMIT, ExploreUsers } from "./explore-users";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type {
  FollowCounts,
  FollowListRow,
  FollowRepositoryPort,
} from "../ports/follow-repository.port";

function row(handle: string): FollowListRow {
  return { handle, displayName: handle, bio: null };
}

/** The same row as it leaves the use case: the projection plus the viewer's own state. */
function anonymousRow(handle: string) {
  return { ...row(handle), viewerFollows: null };
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

/**
 * The follow side, faked only far enough to answer the ONE question
 * `ExploreUsers` asks it — final review, item 1. `calls` is the point of this
 * fake existing: the brief requires the whole screen's follow state in ONE
 * query, and Jelajah renders THREE lists, so "one call per list" would be a
 * plausible-looking wrong answer that no output assertion could distinguish.
 */
class FakeFollowRepository implements FollowRepositoryPort {
  calls: Array<{ viewerId: string; handles: readonly string[] }> = [];

  constructor(private readonly followed: string[] = []) {}

  async follow(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async unfollow(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async isFollowing(): Promise<boolean> {
    throw new Error("not used in these tests");
  }
  async countsFor(): Promise<FollowCounts> {
    throw new Error("not used in these tests");
  }
  async listFollowers(): Promise<FollowListRow[]> {
    throw new Error("not used in these tests");
  }
  async listFollowing(): Promise<FollowListRow[]> {
    throw new Error("not used in these tests");
  }

  async followedHandlesAmong(viewerId: string, handles: readonly string[]): Promise<string[]> {
    this.calls.push({ viewerId, handles });
    return this.followed.filter((handle) => handles.includes(handle));
  }
}

describe("ExploreUsers", () => {
  it("with no q: returns empty results but still returns both newest and mostFollowed", async () => {
    const users = new FakeUserRepository([row("shouldnotappear")], [row("newbie")], [row("famous")]);
    const useCase = new ExploreUsers(users, new FakeFollowRepository());

    const result = await useCase.execute({});

    expect(result.results).toEqual([]);
    expect(result.newest).toEqual([anonymousRow("newbie")]);
    expect(result.mostFollowed).toEqual([anonymousRow("famous")]);
    // The default state of the screen, not a search — searchPublic must not
    // even be called when there is nothing to search for.
    expect(users.searchCalls).toHaveLength(0);
  });

  it("with a whitespace-only q: behaves identically to no q at all", async () => {
    const users = new FakeUserRepository([row("shouldnotappear")], [row("newbie")], [row("famous")]);
    const useCase = new ExploreUsers(users, new FakeFollowRepository());

    const result = await useCase.execute({ q: "   " });

    expect(result.results).toEqual([]);
    expect(users.searchCalls).toHaveLength(0);
  });

  it("with a q: calls searchPublic with the trimmed query and returns its rows as results", async () => {
    const users = new FakeUserRepository([row("wildan")], [], []);
    const useCase = new ExploreUsers(users, new FakeFollowRepository());

    const result = await useCase.execute({ q: "  wildan  " });

    expect(result.results).toEqual([anonymousRow("wildan")]);
    expect(users.searchCalls).toEqual([{ query: "wildan", limit: DEFAULT_EXPLORE_LIMIT }]);
  });

  it("still returns newest and mostFollowed alongside a non-empty q", async () => {
    const users = new FakeUserRepository([row("wildan")], [row("newbie")], [row("famous")]);
    const useCase = new ExploreUsers(users, new FakeFollowRepository());

    const result = await useCase.execute({ q: "wildan" });

    expect(result.newest).toEqual([anonymousRow("newbie")]);
    expect(result.mostFollowed).toEqual([anonymousRow("famous")]);
  });

  it("defaults the limit passed to all three reads when none is given", async () => {
    const users = new FakeUserRepository([], [], []);
    const useCase = new ExploreUsers(users, new FakeFollowRepository());

    await useCase.execute({ q: "x" });

    expect(users.searchCalls[0]?.limit).toBe(DEFAULT_EXPLORE_LIMIT);
    expect(users.newestCalls[0]).toBe(DEFAULT_EXPLORE_LIMIT);
    expect(users.mostFollowedCalls[0]).toBe(DEFAULT_EXPLORE_LIMIT);
  });

  it("forwards an explicit limit to all three reads", async () => {
    const users = new FakeUserRepository([], [], []);
    const useCase = new ExploreUsers(users, new FakeFollowRepository());

    await useCase.execute({ q: "x", limit: 7 });

    expect(users.searchCalls[0]?.limit).toBe(7);
    expect(users.newestCalls[0]).toBe(7);
    expect(users.mostFollowedCalls[0]).toBe(7);
  });
});

/**
 * Final review, must-fix item 1 — the per-row follow state, and the explicit
 * ruling on HOW: "resolve the whole page's follow state in one query, not N ...
 * Do not loop."
 */
describe("ExploreUsers — per-row viewerFollows (item 1)", () => {
  it("anonymous: every row's viewerFollows is null, and the follow repository is never touched", async () => {
    const users = new FakeUserRepository([row("a")], [row("b")], [row("c")]);
    const follows = new FakeFollowRepository(["a", "b", "c"]);
    const useCase = new ExploreUsers(users, follows);

    const result = await useCase.execute({ q: "a", viewerId: null });

    for (const list of [result.results, result.newest, result.mostFollowed]) {
      expect(list).toHaveLength(1);
      expect(list[0]!.viewerFollows).toBeNull();
    }
    // No viewer, no query. `null` must never be answered as `false`, and it must
    // not cost a round trip either.
    expect(follows.calls).toHaveLength(0);
  });

  it("signed in: true for followed handles, false for the rest", async () => {
    const users = new FakeUserRepository([row("followed")], [row("stranger")], [row("followed")]);
    const follows = new FakeFollowRepository(["followed"]);
    const useCase = new ExploreUsers(users, follows);

    const result = await useCase.execute({ q: "f", viewerId: "viewer-1" });

    expect(result.results[0]!.viewerFollows).toBe(true);
    expect(result.newest[0]!.viewerFollows).toBe(false);
    // The SAME account in a second list gets the same answer — the set is
    // resolved once and mapped over each list, not resolved per list.
    expect(result.mostFollowed[0]!.viewerFollows).toBe(true);
  });

  it("THE RULING: one query for the whole screen, not one per list and not one per row", async () => {
    const users = new FakeUserRepository(
      [row("r1"), row("r2")],
      [row("n1"), row("n2"), row("n3")],
      [row("m1"), row("m2")]
    );
    const follows = new FakeFollowRepository([]);
    const useCase = new ExploreUsers(users, follows);

    await useCase.execute({ q: "x", viewerId: "viewer-1" });

    // 7 rows across 3 lists -> exactly 1 lookup. A per-list implementation
    // gives 3 and a per-row one gives 7; both would satisfy every output
    // assertion above, which is why this is asserted directly.
    expect(follows.calls).toHaveLength(1);
    expect(follows.calls[0]!.viewerId).toBe("viewer-1");
    expect([...follows.calls[0]!.handles].sort()).toEqual([
      "m1",
      "m2",
      "n1",
      "n2",
      "n3",
      "r1",
      "r2",
    ]);
  });

  it("de-duplicates a handle appearing in more than one list before querying", async () => {
    // A newly-created popular account is in BOTH rails and in the results.
    const users = new FakeUserRepository([row("everywhere")], [row("everywhere")], [row("everywhere")]);
    const follows = new FakeFollowRepository([]);
    const useCase = new ExploreUsers(users, follows);

    await useCase.execute({ q: "e", viewerId: "viewer-1" });

    expect(follows.calls).toHaveLength(1);
    expect(follows.calls[0]!.handles).toEqual(["everywhere"]);
  });

  it("asks nothing when there are no rows at all, signed in or not", async () => {
    const follows = new FakeFollowRepository([]);
    const useCase = new ExploreUsers(new FakeUserRepository([], [], []), follows);

    await useCase.execute({ viewerId: "viewer-1" });

    expect(follows.calls).toHaveLength(0);
  });

  it("an absent viewerId is treated as anonymous, not as an error", async () => {
    const follows = new FakeFollowRepository(["b"]);
    const useCase = new ExploreUsers(new FakeUserRepository([], [row("b")], []), follows);

    const result = await useCase.execute({});

    expect(result.newest[0]!.viewerFollows).toBeNull();
    expect(follows.calls).toHaveLength(0);
  });
});
