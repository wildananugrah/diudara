import { describe, expect, it } from "bun:test";
import { NotFoundError } from "../errors";
import type { PostRepositoryPort, PostRow } from "../ports/post-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import { ListFeed, ListUserPosts } from "./read-posts";

function fakeRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000000",
    body: "halo",
    createdAt: new Date("2026-08-18T03:00:00.000Z"),
    editedAt: null,
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

const VIEWER = "11111111-0000-4000-8000-000000000000";

/**
 * Records every call made to each list method — the only way to assert
 * `ListFeed`/`ListUserPosts` called the RIGHT repository method with the
 * RIGHT arguments, rather than merely that some page came back.
 */
class FakePosts implements PostRepositoryPort {
  globalCalls: Array<{ limit: number; before: unknown }> = [];
  followingCalls: Array<{ viewerId: string; limit: number; before: unknown }> = [];
  byAuthorCalls: Array<{ authorId: string; limit: number; before: unknown }> = [];
  rows: PostRow[] = [];

  async create(): Promise<PostRow> {
    return fakeRow();
  }
  async ownershipOf() {
    return null;
  }
  async updateBody(): Promise<PostRow | null> {
    return null;
  }
  async softDelete(): Promise<void> {}
  async listGlobal(limit: number, before: unknown): Promise<PostRow[]> {
    this.globalCalls.push({ limit, before });
    return this.rows;
  }
  async listFollowing(viewerId: string, limit: number, before: unknown): Promise<PostRow[]> {
    this.followingCalls.push({ viewerId, limit, before });
    return this.rows;
  }
  async listByAuthor(authorId: string, limit: number, before: unknown): Promise<PostRow[]> {
    this.byAuthorCalls.push({ authorId, limit, before });
    return this.rows;
  }
}

class FakeUsers implements UserRepositoryPort {
  users: UserRecord[] = [];

  async create(): Promise<UserRecord> {
    throw new Error("not used in these tests");
  }
  async findByHandle(handle: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.handle === handle) ?? null;
  }
  async findById(): Promise<UserRecord | null> {
    return null;
  }
  async findByEmail(): Promise<UserRecord | null> {
    return null;
  }
  async findCredentialsByEmail() {
    return null;
  }
  async setPasswordAndBumpEpoch(): Promise<boolean> {
    return false;
  }
  async updateProfile(): Promise<UserRecord | null> {
    return null;
  }
  async searchPublic() {
    return [];
  }
  async newestPublic() {
    return [];
  }
  async mostFollowedPublic() {
    return [];
  }
}

function fakeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "22222222-0000-4000-8000-000000000000",
    handle: "budi",
    email: "budi@example.com",
    whatsappNumber: null,
    displayName: "Budi",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ListFeed", () => {
  it("untuk-anda calls listGlobal, never listFollowing", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: null,
    });

    expect(posts.globalCalls).toHaveLength(1);
    expect(posts.followingCalls).toHaveLength(0);
  });

  it("untuk-anda asks the repository for limit + 1 — the LITERAL 21 with no limit given", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts).execute({ tab: "untuk-anda", viewerId: null, before: null });

    expect(posts.globalCalls).toEqual([{ limit: 21, before: null }]);
  });

  it("mengikuti calls listFollowing with the viewer id, never listGlobal", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts).execute({
      tab: "mengikuti",
      viewerId: VIEWER,
      limit: 20,
      before: null,
    });

    expect(posts.followingCalls).toEqual([{ viewerId: VIEWER, limit: 21, before: null }]);
    expect(posts.globalCalls).toHaveLength(0);
  });

  it("passes the cursor through to the repository untouched", async () => {
    const posts = new FakePosts();
    const cursor = { timestamp: new Date("2026-08-18T00:00:00.000Z"), id: "x" };
    await new ListFeed(posts).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: cursor,
    });

    expect(posts.globalCalls[0]?.before).toBe(cursor);
  });
});

describe("ListUserPosts", () => {
  it("throws NotFoundError for an unknown handle, and never calls listByAuthor", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();

    await expect(
      new ListUserPosts(users, posts).execute({ handle: "tidak-ada", before: null })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(posts.byAuthorCalls).toHaveLength(0);
  });

  it("resolves the handle and lists that author's posts with limit + 1", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));

    await new ListUserPosts(users, posts).execute({ handle: "budi", limit: 20, before: null });

    expect(posts.byAuthorCalls).toEqual([
      { authorId: "22222222-0000-4000-8000-000000000000", limit: 21, before: null },
    ]);
  });

  it("normalises the handle (leading @, mixed case) before the lookup", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));

    const page = await new ListUserPosts(users, posts).execute({ handle: "@Budi", before: null });
    expect(page.posts).toEqual([]);
    expect(posts.byAuthorCalls).toHaveLength(1);
  });
});
