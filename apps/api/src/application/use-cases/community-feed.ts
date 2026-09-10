import { ForbiddenError, NotFoundError } from "../errors";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type { ClockPort } from "../ports/clock.port";
import type { CommentRepositoryPort } from "../ports/comment-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import { paginate } from "./read-posts";
import type { FeedPage, PostView } from "./post-views";
import type { CreatePost } from "./write-post";

const ANNOUNCEMENT_TYPE = "pengumuman";

/**
 * The fallback when a caller passes no limit. `routes/communities.ts` (Task 7)
 * always passes one through `parseFeedLimit`, so this only guards a direct
 * call from a test or a future caller — a private copy on purpose, the same
 * way `read-posts.ts` keeps its own rather than exporting one to be shared.
 */
const DEFAULT_COMMUNITY_FEED_PAGE_SIZE = 20;

/**
 * **An authorisation wrapper around `CreatePost`, and nothing more.**
 *
 * The write itself — media claiming, `MAX_POST_BODY_LENGTH`, the
 * `requireImageWhenLocked` rule and the `PostWriteUnitOfWorkPort` transaction
 * — stays in `CreatePost`, reached through `communityId` and `type`. This
 * class only adds the two questions a community asks that a personal post does
 * not: does the slug exist, and may this author post this `type` here.
 *
 * ORDER MATTERS. `findBySlug` resolves FIRST, before either permission check,
 * so an unknown slug is always a `NotFoundError` and never a `ForbiddenError`
 * — a 403 on a slug that does not exist would confirm to a probe which slugs
 * do. Every check is also before the delegate call, so a rejected request
 * writes nothing.
 */
export class CreateCommunityPost {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly createPost: CreatePost
  ) {}

  async execute(input: {
    slug: string;
    authorId: string;
    body: string;
    type: string;
    mediaIds?: string[];
  }): Promise<PostView> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");

    if (input.type === ANNOUNCEMENT_TYPE) {
      // A `pengumuman` is the owner's alone — membership does not earn it.
      if (community.ownerId !== input.authorId) {
        throw new ForbiddenError("hanya pemilik komunitas yang boleh membuat pengumuman");
      }
    } else if (!(await this.communities.isMember(community.id, input.authorId))) {
      // Any other `type` is a member's to start.
      throw new ForbiddenError("hanya anggota komunitas yang boleh memulai diskusi");
    }

    return this.createPost.execute({
      authorId: input.authorId,
      body: input.body,
      mediaIds: input.mediaIds,
      communityId: community.id,
      type: input.type,
    });
  }
}

/**
 * A community's chronological feed — its own page and nowhere else. Reuses
 * `paginate` from `read-posts.ts` UNCHANGED, including its two batched queries
 * for media and the membership gate; a community post is always
 * `visibility = 'public'` (Task 1's CHECK), so that gate resolves to "not
 * locked" for everyone without a special case here.
 *
 * `viewerId` may be `null`: the feed is readable signed out, which
 * `paginate`'s gate already handles (a signed-out viewer skips the membership
 * query entirely).
 *
 * The comment counts are ONE `comments.countForPosts` for the whole page —
 * `paginate`'s docstring records that a per-post lookup would be 20 round
 * trips on the busiest page in the product, and a live comment count is the
 * third thing on this page that could be fetched per row.
 */
export class ListCommunityFeed {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort,
    private readonly comments: CommentRepositoryPort
  ) {}

  async execute(input: {
    slug: string;
    viewerId: string | null;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");

    const limit = input.limit ?? DEFAULT_COMMUNITY_FEED_PAGE_SIZE;
    const rows = await this.posts.listByCommunity(community.id, limit + 1, input.before);
    const commentCounts = await this.comments.countForPosts(rows.map((row) => row.id));
    return paginate(
      this.media,
      this.subscriptions,
      this.clock,
      rows,
      limit,
      input.viewerId,
      commentCounts
    );
  }
}
