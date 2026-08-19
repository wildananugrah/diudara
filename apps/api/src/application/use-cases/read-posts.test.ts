import { describe, expect, it } from "bun:test";
import { NotFoundError } from "../errors";
import type { MediaRepositoryPort, MediaRow } from "../ports/media-repository.port";
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

/**
 * Records every `listForPosts` call, because the thing worth asserting about
 * media on a feed is not that it arrives but that it costs ONE query for the
 * whole page — a per-row lookup is 20 round trips per feed page.
 */
class FakeMedia implements MediaRepositoryPort {
  forPostsCalls: string[][] = [];
  rows: MediaRow[] = [];

  async create(): Promise<MediaRow> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<MediaRow | null> {
    return null;
  }
  async findManyByIds(): Promise<MediaRow[]> {
    return [];
  }
  async claim(_postId: string, ids: string[]): Promise<number> {
    return ids.length;
  }
  async listForPost(): Promise<MediaRow[]> {
    throw new Error("a feed must never look media up one post at a time");
  }
  async listForPosts(postIds: string[]): Promise<MediaRow[]> {
    this.forPostsCalls.push([...postIds]);
    return this.rows;
  }
  async listUnclaimedBefore(): Promise<MediaRow[]> {
    return [];
  }
  async deleteIfUnclaimed(): Promise<boolean> {
    return false;
  }
}

function fakeMediaRow(overrides: Partial<MediaRow> & { id: string; postId: string }): MediaRow {
  return {
    ownerId: "33333333-0000-4000-8000-000000000000",
    position: 0,
    width: 1600,
    height: 900,
    byteSize: 123456,
    createdAt: new Date("2026-08-18T02:00:00.000Z"),
    ...overrides,
  };
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
    await new ListFeed(posts, new FakeMedia()).execute({
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
    await new ListFeed(posts, new FakeMedia()).execute({ tab: "untuk-anda", viewerId: null, before: null });

    expect(posts.globalCalls).toEqual([{ limit: 21, before: null }]);
  });

  it("mengikuti calls listFollowing with the viewer id, never listGlobal", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts, new FakeMedia()).execute({
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
    await new ListFeed(posts, new FakeMedia()).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: cursor,
    });

    expect(posts.globalCalls[0]?.before).toBe(cursor);
  });

  /**
   * ONE query for the whole page, not one per post — `listForPosts` exists for
   * exactly this, and the ids it is given are the ids the repository just
   * returned.
   */
  it("fetches the page's media in a SINGLE listForPosts call", async () => {
    const posts = new FakePosts();
    posts.rows = [
      fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000" }),
      fakeRow({ id: "bbbbbbbb-0000-4000-8000-000000000000" }),
    ];
    const media = new FakeMedia();

    await new ListFeed(posts, media).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: null,
    });

    expect(media.forPostsCalls).toEqual([
      [
        "aaaaaaaa-0000-4000-8000-000000000000",
        "bbbbbbbb-0000-4000-8000-000000000000",
      ],
    ]);
  });

  it("hands each post its own images", async () => {
    const posts = new FakePosts();
    posts.rows = [
      fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000" }),
      fakeRow({ id: "bbbbbbbb-0000-4000-8000-000000000000" }),
    ];
    const media = new FakeMedia();
    media.rows = [
      fakeMediaRow({
        id: "cccccccc-0000-4000-8000-000000000000",
        postId: "bbbbbbbb-0000-4000-8000-000000000000",
      }),
    ];

    const page = await new ListFeed(posts, media).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: null,
    });

    expect(page.posts[0]!.media).toEqual([]);
    expect(page.posts[1]!.media).toEqual([
      { id: "cccccccc-0000-4000-8000-000000000000", width: 1600, height: 900 },
    ]);
  });
});

describe("ListUserPosts", () => {
  it("throws NotFoundError for an unknown handle, and never calls listByAuthor", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();

    await expect(
      new ListUserPosts(users, posts, new FakeMedia()).execute({ handle: "tidak-ada", before: null })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(posts.byAuthorCalls).toHaveLength(0);
  });

  it("resolves the handle and lists that author's posts with limit + 1", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));

    await new ListUserPosts(users, posts, new FakeMedia()).execute({ handle: "budi", limit: 20, before: null });

    expect(posts.byAuthorCalls).toEqual([
      { authorId: "22222222-0000-4000-8000-000000000000", limit: 21, before: null },
    ]);
  });

  it("normalises the handle (leading @, mixed case) before the lookup", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));

    const page = await new ListUserPosts(users, posts, new FakeMedia()).execute({ handle: "@Budi", before: null });
    expect(page.posts).toEqual([]);
    expect(posts.byAuthorCalls).toHaveLength(1);
  });

  it("fetches the author page's media in a SINGLE listForPosts call", async () => {
    const posts = new FakePosts();
    posts.rows = [fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000" })];
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));
    const media = new FakeMedia();

    await new ListUserPosts(users, posts, media).execute({ handle: "budi", before: null });

    expect(media.forPostsCalls).toEqual([["aaaaaaaa-0000-4000-8000-000000000000"]]);
  });
});
