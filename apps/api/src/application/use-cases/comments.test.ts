import { describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "../errors";
import type {
  CommentOwnership,
  CommentRepositoryPort,
  CommentRow,
} from "../ports/comment-repository.port";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";
import type {
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../ports/post-repository.port";
import { CreateComment, DeleteComment, ListComments } from "./comments";
import { NotifyOf } from "./notify";

/**
 * A real `NotifyOf` over an in-memory repository, so these tests exercise the
 * hook rather than stubbing it away — including the rule that a notification
 * failure must NOT fail the action.
 */
function silentNotifier(): NotifyOf {
  return new NotifyOf({
    async create() {},
    async listFor() {
      return [];
    },
    async unreadCountFor() {
      return 0;
    },
    async markAllRead() {},
  });
}


const POST_ID = "aaaaaaaa-0000-4000-8000-000000000000";
const OTHER_POST_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const COMMUNITY_ID = "cccccccc-0000-4000-8000-000000000000";
const COMMENT_ID = "eeeeeeee-0000-4000-8000-000000000000";
const PARENT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const REPLY_ID = "eeeeeeee-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-000000000000";
const MEMBER_ID = "11111111-0000-4000-8000-000000000000";
const OTHER_MEMBER_ID = "22222222-0000-4000-8000-000000000000";
const STRANGER_ID = "33333333-0000-4000-8000-000000000000";

function commentRow(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: COMMENT_ID,
    body: "halo",
    createdAt: new Date("2026-09-10T08:00:00.000Z"),
    authorId: MEMBER_ID,
    authorHandle: "budi",
    authorDisplayName: "Budi",
    parentId: null,
    ...overrides,
  };
}

/**
 * Post-repo stand-in — the `ownershipOf`-driven shape `write-post.test.ts`
 * uses, trimmed to the one read the comment use-cases make. `ownershipCalls`
 * is asserted on so "the author's own comment is settled without resolving
 * the post" can be proven, not just assumed.
 */
class FakePosts implements PostRepositoryPort {
  ownership: PostOwnership | null = null;
  ownershipCalls: string[] = [];

  async ownershipOf(id: string): Promise<PostOwnership | null> {
    this.ownershipCalls.push(id);
    return this.ownership;
  }
  async create(): Promise<PostRow> {
    throw new Error("not used in these tests");
  }
  async getById(): Promise<PostRow | null> {
    return null;
  }
  async lockForEdit(): Promise<PostOwnership | null> {
    return this.ownership;
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
  async listByCommunity(): Promise<PostRow[]> {
    return [];
  }
}

/**
 * In-memory comment repo — `create` and `softDelete` RECORD rather than
 * mutate, which is what the "nothing is written" assertions read. `create`
 * still returns a well-formed row so `CreateComment`'s mapping is exercised.
 */
class FakeComments implements CommentRepositoryPort {
  /** Read by `ownershipOf` when a given id has no entry in `ownershipById` — every existing `DeleteComment` test sets only this, ignoring the id it's looked up under. */
  ownership: CommentOwnership | null = null;
  /** Per-id overrides, keyed by comment id — what a reply's parent lookup needs, since `CreateComment.resolveParentId` calls `ownershipOf(parentId)` with a SPECIFIC id that must resolve to that parent's own row, not to whatever `.ownership` happens to hold. */
  ownershipById: Record<string, CommentOwnership> = {};
  rows: CommentRow[] = [];
  created: Array<{ postId: string; authorId: string; body: string; parentId: string | null }> = [];
  softDeleted: string[] = [];
  listForPostCalls: Array<{ postId: string; limit: number }> = [];

  async create(
    postId: string,
    authorId: string,
    body: string,
    parentId: string | null
  ): Promise<CommentRow> {
    this.created.push({ postId, authorId, body, parentId });
    return commentRow({ body, authorId, parentId });
  }
  async listForPost(postId: string, limit: number): Promise<CommentRow[]> {
    this.listForPostCalls.push({ postId, limit });
    return this.rows;
  }
  async countForPosts(): Promise<Map<string, number>> {
    throw new Error("not used in these tests");
  }
  async ownershipOf(id: string): Promise<CommentOwnership | null> {
    return this.ownershipById[id] ?? this.ownership;
  }
  async softDelete(id: string): Promise<void> {
    this.softDeleted.push(id);
  }
}

function communityRecord(overrides: Partial<CommunityRecord> = {}): CommunityRecord {
  return {
    id: COMMUNITY_ID,
    ownerId: OWNER_ID,
    slug: "kelas-fisika",
    name: "Kelas Fisika",
    category: "Akademik",
    description: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    tags: [],
    ...overrides,
  };
}

/**
 * Community-repo stand-in — the rows-plus-membership shape
 * `join-community.test.ts` uses, with `findById` (ruling R9) added the same
 * way its `findBySlug` sibling reads. `members` seeds the owner and two
 * ordinary members; a stranger is anyone else.
 */
class FakeCommunities implements CommunityRepositoryPort {
  records: CommunityRecord[] = [];
  members = new Set<string>([OWNER_ID, MEMBER_ID, OTHER_MEMBER_ID]);

  async findById(id: string): Promise<CommunityRecord | null> {
    return this.records.find((r) => r.id === id) ?? null;
  }
  async isMember(_communityId: string, userId: string): Promise<boolean> {
    return this.members.has(userId);
  }
  async findBySlug(): Promise<CommunityRecord | null> {
    throw new Error("not used in these tests");
  }
  async create(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async browse(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async setTags(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async popularTags(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async liveByOwner(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async cheapestActivePrices(): Promise<never> {
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
  async listJoinedByMember(): Promise<never> {
    throw new Error("not used in these tests");
  }
  /** Phase 8b. Not reached by these tests — direct messages have their own suite. */
  async sharesCommunityWith() {
    return false;
  }
}

function subject() {
  const posts = new FakePosts();
  const comments = new FakeComments();
  const communities = new FakeCommunities();
  communities.records.push(communityRecord());
  return { posts, comments, communities };
}

describe("CreateComment", () => {
  test("a member of the post's community may comment", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };

    const view = await new CreateComment(comments, posts, communities, silentNotifier()).execute({
      postId: POST_ID,
      authorId: MEMBER_ID,
      body: "halo",
    });

    expect(comments.created).toEqual([
      { postId: POST_ID, authorId: MEMBER_ID, body: "halo", parentId: null },
    ]);
    expect(view.body).toBe("halo");
    expect(view.author.handle).toBe("budi");
    expect(view.parentId).toBeNull();
  });

  test("a non-member may not", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };

    await expect(
      new CreateComment(comments, posts, communities, silentNotifier()).execute({
        postId: POST_ID,
        authorId: STRANGER_ID,
        body: "halo",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(comments.created).toEqual([]);
  });

  test("a PERSONAL post cannot be commented on at all", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      // communityId null — there is no membership that could authorise this,
      // the spec's "only community posts take comments".
      communityId: null,
    };

    await expect(
      new CreateComment(comments, posts, communities, silentNotifier()).execute({
        postId: POST_ID,
        authorId: MEMBER_ID,
        body: "halo",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(comments.created).toEqual([]);
  });

  test("a deleted post cannot be commented on", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: true,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };

    await expect(
      new CreateComment(comments, posts, communities, silentNotifier()).execute({
        postId: POST_ID,
        authorId: MEMBER_ID,
        body: "halo",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(comments.created).toEqual([]);
  });

  test("a post that never existed is not found", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = null;

    await expect(
      new CreateComment(comments, posts, communities, silentNotifier()).execute({
        postId: POST_ID,
        authorId: MEMBER_ID,
        body: "halo",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("replying to a top-level comment attaches to it directly", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };
    comments.ownershipById[PARENT_ID] = {
      id: PARENT_ID,
      authorId: OTHER_MEMBER_ID,
      postId: POST_ID,
      isDeleted: false,
      parentId: null,
    };

    const view = await new CreateComment(comments, posts, communities, silentNotifier()).execute({
      postId: POST_ID,
      authorId: MEMBER_ID,
      body: "setuju",
      parentId: PARENT_ID,
    });

    expect(comments.created).toEqual([
      { postId: POST_ID, authorId: MEMBER_ID, body: "setuju", parentId: PARENT_ID },
    ]);
    expect(view.parentId).toBe(PARENT_ID);
  });

  /**
   * ONE level of nesting (the class docstring's rule): a reply aimed at
   * another REPLY does not nest two deep — it flattens onto that reply's own
   * top-level parent, so `PARENT_ID` ends up as the stored `parentId`, never
   * `REPLY_ID`.
   */
  test("replying to a reply flattens onto that reply's own top-level ancestor", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };
    comments.ownershipById[REPLY_ID] = {
      id: REPLY_ID,
      authorId: OTHER_MEMBER_ID,
      postId: POST_ID,
      isDeleted: false,
      parentId: PARENT_ID,
    };

    const view = await new CreateComment(comments, posts, communities, silentNotifier()).execute({
      postId: POST_ID,
      authorId: MEMBER_ID,
      body: "juga setuju",
      parentId: REPLY_ID,
    });

    expect(comments.created).toEqual([
      { postId: POST_ID, authorId: MEMBER_ID, body: "juga setuju", parentId: PARENT_ID },
    ]);
    expect(view.parentId).toBe(PARENT_ID);
  });

  test("replying to a comment on a DIFFERENT post is not found", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };
    comments.ownershipById[PARENT_ID] = {
      id: PARENT_ID,
      authorId: OTHER_MEMBER_ID,
      postId: OTHER_POST_ID,
      isDeleted: false,
      parentId: null,
    };

    await expect(
      new CreateComment(comments, posts, communities, silentNotifier()).execute({
        postId: POST_ID,
        authorId: MEMBER_ID,
        body: "salah tempat",
        parentId: PARENT_ID,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(comments.created).toEqual([]);
  });

  test("replying to a comment id that never existed is not found", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };

    await expect(
      new CreateComment(comments, posts, communities, silentNotifier()).execute({
        postId: POST_ID,
        authorId: MEMBER_ID,
        body: "halo",
        parentId: PARENT_ID,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(comments.created).toEqual([]);
  });

  test("replying to an already soft-deleted comment is still allowed", async () => {
    const { posts, comments, communities } = subject();
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };
    comments.ownershipById[PARENT_ID] = {
      id: PARENT_ID,
      authorId: OTHER_MEMBER_ID,
      postId: POST_ID,
      isDeleted: true,
      parentId: null,
    };

    const view = await new CreateComment(comments, posts, communities, silentNotifier()).execute({
      postId: POST_ID,
      authorId: MEMBER_ID,
      body: "masih relevan",
      parentId: PARENT_ID,
    });

    expect(view.parentId).toBe(PARENT_ID);
  });
});

describe("DeleteComment", () => {
  test("the author may delete their own", async () => {
    const { posts, comments, communities } = subject();
    comments.ownership = {
      id: COMMENT_ID,
      authorId: MEMBER_ID,
      postId: POST_ID,
      isDeleted: false,
      parentId: null,
    };

    await new DeleteComment(comments, posts, communities).execute({
      commentId: COMMENT_ID,
      deleterId: MEMBER_ID,
    });

    expect(comments.softDeleted).toEqual([COMMENT_ID]);
    // Settled on the author's own say-so — the post is never resolved.
    expect(posts.ownershipCalls).toEqual([]);
  });

  test("the community owner may delete anybody's", async () => {
    const { posts, comments, communities } = subject();
    comments.ownership = {
      id: COMMENT_ID,
      authorId: OTHER_MEMBER_ID,
      postId: POST_ID,
      isDeleted: false,
      parentId: null,
    };
    posts.ownership = {
      id: POST_ID,
      authorId: OTHER_MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };

    await new DeleteComment(comments, posts, communities).execute({
      commentId: COMMENT_ID,
      deleterId: OWNER_ID,
    });

    expect(comments.softDeleted).toEqual([COMMENT_ID]);
  });

  test("another member may not", async () => {
    const { posts, comments, communities } = subject();
    comments.ownership = {
      id: COMMENT_ID,
      authorId: MEMBER_ID,
      postId: POST_ID,
      isDeleted: false,
      parentId: null,
    };
    posts.ownership = {
      id: POST_ID,
      authorId: MEMBER_ID,
      isDeleted: false,
      visibility: "public",
      communityId: COMMUNITY_ID,
    };

    await expect(
      new DeleteComment(comments, posts, communities).execute({
        commentId: COMMENT_ID,
        deleterId: OTHER_MEMBER_ID,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(comments.softDeleted).toEqual([]);
  });

  test("deleting an already-deleted comment is a no-op, not an error", async () => {
    const { posts, comments, communities } = subject();
    comments.ownership = {
      id: COMMENT_ID,
      authorId: MEMBER_ID,
      postId: POST_ID,
      isDeleted: true,
      parentId: null,
    };

    await new DeleteComment(comments, posts, communities).execute({
      commentId: COMMENT_ID,
      deleterId: MEMBER_ID,
    });

    expect(comments.softDeleted).toEqual([COMMENT_ID]);
  });

  test("a comment that never existed is not found", async () => {
    const { posts, comments, communities } = subject();
    comments.ownership = null;

    await expect(
      new DeleteComment(comments, posts, communities).execute({
        commentId: COMMENT_ID,
        deleterId: MEMBER_ID,
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ListComments", () => {
  test("maps rows to views with an ISO createdAt and a nested author", async () => {
    const { comments } = subject();
    comments.rows = [
      commentRow({
        id: "c1",
        body: "pertama",
        createdAt: new Date("2026-09-10T08:00:00.000Z"),
        authorHandle: "budi",
        authorDisplayName: "Budi",
      }),
      commentRow({
        id: "c2",
        body: "kedua",
        createdAt: new Date("2026-09-10T09:00:00.000Z"),
        authorHandle: "sari",
        authorDisplayName: "Sari",
      }),
    ];

    const views = await new ListComments(comments).execute({ postId: POST_ID });

    expect(views.map((v) => `${v.id}:${v.body}:${v.author.handle}:${v.author.displayName}`)).toEqual([
      "c1:pertama:budi:Budi",
      "c2:kedua:sari:Sari",
    ]);
    expect(views[0]!.createdAt).toBe("2026-09-10T08:00:00.000Z");
  });

  test("passes the default page size to the repository when no limit is given", async () => {
    const { comments } = subject();
    await new ListComments(comments).execute({ postId: POST_ID });
    expect(comments.listForPostCalls).toEqual([{ postId: POST_ID, limit: 50 }]);
  });

  test("passes a caller-supplied limit straight through", async () => {
    const { comments } = subject();
    await new ListComments(comments).execute({ postId: POST_ID, limit: 5 });
    expect(comments.listForPostCalls).toEqual([{ postId: POST_ID, limit: 5 }]);
  });
});
