import { describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import type { CommentRepositoryPort, CommentRow } from "../ports/comment-repository.port";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";
import type { MediaRepositoryPort, MediaRow } from "../ports/media-repository.port";
import type { PostRepositoryPort, PostRow } from "../ports/post-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import { CreateCommunityPost, ListCommunityFeed } from "./community-feed";
import { CreatePost } from "./write-post";

const COMMUNITY_ID = "cccccccc-0000-4000-8000-000000000000";
const OWNER_ID = "00000000-0000-4000-8000-000000000000";
const MEMBER_ID = "11111111-0000-4000-8000-000000000000";
const STRANGER_ID = "22222222-0000-4000-8000-000000000000";
const POST_A = "aaaaaaaa-0000-4000-8000-000000000000";
const POST_B = "bbbbbbbb-0000-4000-8000-000000000000";

function community(overrides: Partial<CommunityRecord> = {}): CommunityRecord {
  return {
    id: COMMUNITY_ID,
    ownerId: OWNER_ID,
    slug: "kelas-fisika",
    name: "Kelas Fisika",
    category: "Akademik",
    description: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Community-repo stand-in — the shape `join-community.test.ts` uses. `members`
 * seeds the owner and one ordinary member; a stranger is anyone else.
 */
class FakeCommunities implements CommunityRepositoryPort {
  members = new Set<string>([OWNER_ID, MEMBER_ID]);

  constructor(private readonly rows: CommunityRecord[]) {}

  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return this.rows.find((r) => r.slug === slug) ?? null;
  }
  async isMember(_communityId: string, userId: string): Promise<boolean> {
    return this.members.has(userId);
  }
  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async browse(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async memberCountFor(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async join(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async leave(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async listMembers(): Promise<never> {
    throw new Error("not used in these tests");
  }
}

function postRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: POST_A,
    body: "halo",
    createdAt: new Date("2026-08-18T03:00:00.000Z"),
    editedAt: null,
    authorId: MEMBER_ID,
    visibility: "public",
    communityId: COMMUNITY_ID,
    type: "diskusi",
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

/**
 * Post-repo stand-in — the shape `read-posts.test.ts` uses, plus `created`
 * (from `write-post.test.ts`), because `CreateCommunityPost` delegates its
 * write to `CreatePost` and the tests assert what reached `posts.create`.
 */
class FakePosts implements PostRepositoryPort {
  created: Array<{
    authorId: string;
    body: string;
    visibility?: string;
    communityId?: string;
    type?: string;
  }> = [];
  byCommunityRows: PostRow[] = [];
  byCommunityCalls: Array<{ communityId: string; limit: number; before: unknown }> = [];

  async create(input: {
    authorId: string;
    body: string;
    visibility?: string;
    communityId?: string;
    type?: string;
  }): Promise<PostRow> {
    this.created.push(input);
    return postRow({
      body: input.body,
      authorId: input.authorId,
      visibility: input.visibility ?? "public",
      communityId: input.communityId ?? null,
      type: input.type ?? "diskusi",
    });
  }
  async listByCommunity(communityId: string, limit: number, before: unknown): Promise<PostRow[]> {
    this.byCommunityCalls.push({ communityId, limit, before });
    return this.byCommunityRows;
  }
  async getById(): Promise<PostRow | null> {
    return null;
  }
  async ownershipOf() {
    return null;
  }
  async lockForEdit() {
    return null;
  }
  async gatingOf() {
    return null;
  }
  async updateBody(): Promise<PostRow | null> {
    return null;
  }
  async softDelete(): Promise<void> {}
  async listGlobal(): Promise<PostRow[]> {
    return [];
  }
  async listFollowing(): Promise<PostRow[]> {
    return [];
  }
  async listByAuthor(): Promise<PostRow[]> {
    return [];
  }
}

class FakeMedia implements MediaRepositoryPort {
  forPostsCalls: string[][] = [];

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
    return [];
  }
  async listForPosts(postIds: string[]): Promise<MediaRow[]> {
    this.forPostsCalls.push([...postIds]);
    return [];
  }
  async listUnclaimedBefore(): Promise<MediaRow[]> {
    return [];
  }
  async deleteIfUnclaimed(): Promise<boolean> {
    return false;
  }
}

/**
 * A community post is always `visibility = 'public'` (Task 1's CHECK), so
 * `paginate`'s gate never reaches this — every method throws bar the one it
 * would call if a gated row somehow arrived, which answers "nobody".
 */
class FakeSubscriptions implements UserSubscriptionRepositoryPort {
  amongCalls: Array<{ subscriberId: string; ownerIds: string[]; now: Date }> = [];

  async listActiveOwnersAmong(
    subscriberId: string,
    ownerIds: string[],
    now: Date
  ): Promise<string[]> {
    this.amongCalls.push({ subscriberId, ownerIds: [...ownerIds], now });
    return [];
  }

  private unused(): never {
    throw new Error("not used in these tests");
  }
  async create(): Promise<never> {
    return this.unused();
  }
  async claimPending(): Promise<never> {
    return this.unused();
  }
  async findById(): Promise<never> {
    return this.unused();
  }
  async activate(): Promise<never> {
    return this.unused();
  }
  async cancel(): Promise<never> {
    return this.unused();
  }
  async retireExpired(): Promise<never> {
    return this.unused();
  }
  async listExpiredActive(): Promise<never> {
    return this.unused();
  }
  async listStalePending(): Promise<never> {
    return this.unused();
  }
  async expireStalePending(): Promise<never> {
    return this.unused();
  }
  async findExpirableInvoice(): Promise<never> {
    return this.unused();
  }
  async listExpiringActive(): Promise<never> {
    return this.unused();
  }
  async findActiveFor(): Promise<never> {
    return this.unused();
  }
  async findPendingFor(): Promise<never> {
    return this.unused();
  }
  async listActiveSubscribers(): Promise<never> {
    return this.unused();
  }
  async createTransaction(): Promise<never> {
    return this.unused();
  }
  async findTransactionById(): Promise<never> {
    return this.unused();
  }
  async attachGatewayReference(): Promise<never> {
    return this.unused();
  }
  async findPendingCheckout(): Promise<never> {
    return this.unused();
  }
  async markTransactionPaid(): Promise<never> {
    return this.unused();
  }
  async listPendingRequests(): Promise<never> {
    return this.unused();
  }
  async approveFreeRequest(): Promise<never> {
    return this.unused();
  }
  async rejectRequest(): Promise<never> {
    return this.unused();
  }
}

class FakeComments implements CommentRepositoryPort {
  countForPostsCalls: string[][] = [];
  counts = new Map<string, number>();

  async countForPosts(postIds: string[]): Promise<Map<string, number>> {
    this.countForPostsCalls.push([...postIds]);
    return this.counts;
  }
  async create(): Promise<CommentRow> {
    throw new Error("not used in these tests");
  }
  async listForPost(): Promise<CommentRow[]> {
    throw new Error("not used in these tests");
  }
  async ownershipOf() {
    return null;
  }
  async softDelete(): Promise<void> {}
}

const clock: ClockPort = { now: () => new Date("2026-09-10T00:00:00.000Z") };

function createSubject() {
  const communities = new FakeCommunities([community()]);
  const posts = new FakePosts();
  const media = new FakeMedia();
  const createPost = new CreatePost({ run: (work) => work({ posts, media }) });
  return { posts, useCase: new CreateCommunityPost(communities, createPost) };
}

describe("CreateCommunityPost", () => {
  test("a member may start a diskusi — the write is delegated with the community id and type", async () => {
    const { posts, useCase } = createSubject();

    const view = await useCase.execute({
      slug: "kelas-fisika",
      authorId: MEMBER_ID,
      body: "halo semua",
      type: "diskusi",
    });

    expect(posts.created).toHaveLength(1);
    expect(posts.created[0]!.communityId).toBe(COMMUNITY_ID);
    expect(posts.created[0]!.type).toBe("diskusi");
    expect(view.type).toBe("diskusi");
    expect(view.commentCount).toBe(0);
  });

  test("a non-member may not, and nothing is written", async () => {
    const { posts, useCase } = createSubject();

    await expect(
      useCase.execute({ slug: "kelas-fisika", authorId: STRANGER_ID, body: "halo", type: "diskusi" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.created).toEqual([]);
  });

  test("a member may not post a pengumuman, and nothing is written", async () => {
    const { posts, useCase } = createSubject();

    await expect(
      useCase.execute({ slug: "kelas-fisika", authorId: MEMBER_ID, body: "x", type: "pengumuman" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.created).toEqual([]);
  });

  test("the owner may post a pengumuman", async () => {
    const { posts, useCase } = createSubject();

    const view = await useCase.execute({
      slug: "kelas-fisika",
      authorId: OWNER_ID,
      body: "penting",
      type: "pengumuman",
    });

    expect(posts.created[0]!.type).toBe("pengumuman");
    expect(posts.created[0]!.communityId).toBe(COMMUNITY_ID);
    expect(view.type).toBe("pengumuman");
  });

  test("an unknown slug is a NotFoundError, checked before membership", async () => {
    const { posts, useCase } = createSubject();

    await expect(
      useCase.execute({ slug: "tidak-ada", authorId: STRANGER_ID, body: "x", type: "diskusi" })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(posts.created).toEqual([]);
  });
});

function listSubject() {
  const communities = new FakeCommunities([community()]);
  const posts = new FakePosts();
  posts.byCommunityRows = [postRow({ id: POST_A }), postRow({ id: POST_B })];
  const media = new FakeMedia();
  const comments = new FakeComments();
  const useCase = new ListCommunityFeed(
    communities,
    posts,
    media,
    new FakeSubscriptions(),
    clock,
    comments
  );
  return { posts, comments, useCase };
}

describe("ListCommunityFeed", () => {
  test("a signed-out viewer gets the page", async () => {
    const { useCase } = listSubject();

    const page = await useCase.execute({ slug: "kelas-fisika", viewerId: null, before: null });

    expect(page.posts.map((p) => p.id)).toEqual([POST_A, POST_B]);
  });

  test("comment counts come from ONE batched call for the whole page", async () => {
    const { comments, useCase } = listSubject();

    await useCase.execute({ slug: "kelas-fisika", viewerId: null, before: null });

    expect(comments.countForPostsCalls).toHaveLength(1);
    expect(comments.countForPostsCalls[0]).toEqual([POST_A, POST_B]);
  });

  test("threads each post's count from that one call onto its view, zero when absent", async () => {
    const { comments, useCase } = listSubject();
    comments.counts = new Map([[POST_A, 3]]);

    const page = await useCase.execute({ slug: "kelas-fisika", viewerId: null, before: null });

    expect(page.posts[0]!.commentCount).toBe(3);
    expect(page.posts[1]!.commentCount).toBe(0);
  });

  test("asks the repository for limit + 1 rows", async () => {
    const { posts, useCase } = listSubject();

    await useCase.execute({ slug: "kelas-fisika", viewerId: null, limit: 10, before: null });

    expect(posts.byCommunityCalls).toEqual([{ communityId: COMMUNITY_ID, limit: 11, before: null }]);
  });

  test("an unknown slug is a NotFoundError, and the feed is never read", async () => {
    const { posts, useCase } = listSubject();

    await expect(
      useCase.execute({ slug: "tidak-ada", viewerId: null, before: null })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(posts.byCommunityCalls).toEqual([]);
  });
});
