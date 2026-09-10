import { NotFoundError } from "../errors";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type { ClockPort } from "../ports/clock.port";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { PostRepositoryPort, PostRow } from "../ports/post-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import { normalizeHandle } from "../../domain/handle";
import { MEMBERS_ONLY, toFeedPage, type FeedPage, type PostView } from "./post-views";

/**
 * The fallback when a caller passes no limit. `routes/posts.ts` always passes one,
 * so this only guards a direct call from a test or a future caller.
 */
const DEFAULT_FEED_PAGE_SIZE = 20;

/**
 * The empty comment map the two PERSONAL feeds hand `paginate`. A personal
 * post takes no comments this phase, so an empty map is the honest answer —
 * and passing it explicitly at each call site, rather than letting the
 * parameter default, is what keeps "a feed forgot to fetch its counts" a
 * compile error instead of a page of silent zeros. `ListCommunityFeed` (in
 * `community-feed.ts`) passes a real map from one batched query.
 */
const NO_COMMENT_COUNTS: ReadonlyMap<string, number> = new Map();

export type FeedTab = "untuk-anda" | "mengikuti";

/**
 * **THE GATE, and it is deliberately a step you can read here** rather than a
 * `LEFT JOIN` buried in the feed's tuned SQL (spec §6.1).
 *
 * Two batched queries for the whole page, whatever the page size:
 *
 *  - the page's images — ONE `listForPosts`, not one lookup per post, which
 *    would be 20 round trips per feed page. The media is fetched for every row
 *    the repository returned, INCLUDING the probe row: `toFeedPage` is what
 *    knows which rows survive the slice, and it drops the probe's media along
 *    with the probe. Fetching for one extra post is cheaper than teaching this
 *    function the probe-row rule a second time;
 *  - the viewer's memberships among this page's GATED authors — ONE
 *    `listActiveOwnersAmong`, for the same reason. A 20-post page from 12
 *    authors asked per post would be 12 queries on the busiest page in the
 *    product.
 *
 * A post is LOCKED when `visibility = 'members'` and the viewer is neither its
 * author nor a current member (paying, or free and approved). The set starts as every gated author
 * on the page and memberships are REMOVED from it, so the failure direction of
 * a bug here — a missing row, a query that answers nothing — is locked out,
 * never let in.
 *
 * A signed-out viewer (`viewerId === null`) skips the query entirely: there is
 * no subscriber id to ask about, and the only answer such a query could have
 * is the one this set already holds.
 *
 * `commentCounts` is threaded straight through to `toFeedPage` — the whole
 * page's live comment counts as ONE map, for the same round-trip reason the
 * media and membership lookups are batched. The personal callers pass
 * `NO_COMMENT_COUNTS`; `ListCommunityFeed` passes the result of one
 * `comments.countForPosts`. EXPORTED so `community-feed.ts` reuses this exact
 * gate rather than a second copy of the lock rule, and so `GetPost` below can
 * run a one-row "page" through it unchanged.
 */
export async function paginate(
  media: MediaRepositoryPort,
  subscriptions: UserSubscriptionRepositoryPort,
  clock: ClockPort,
  rows: PostRow[],
  limit: number,
  viewerId: string | null,
  commentCounts: ReadonlyMap<string, number>
): Promise<FeedPage> {
  // Read the clock ONCE and pass the instant down. Phase 5b shipped a residual
  // defect caused by a use case reading `clock.now()` twice around a query: a
  // membership whose period ended between the two reads was answered
  // inconsistently. One page, one instant.
  const now = clock.now();
  // The author of a gated post is never locked out of it, and is never asked
  // about either — nobody subscribes to themselves, so the query would be a
  // round trip whose answer cannot be yes.
  const gated = rows.filter((row) => row.visibility === MEMBERS_ONLY && row.authorId !== viewerId);
  const lockedAuthors = new Set(gated.map((row) => row.authorId));
  if (viewerId !== null && lockedAuthors.size > 0) {
    for (const ownerId of await subscriptions.listActiveOwnersAmong(
      viewerId,
      [...lockedAuthors],
      now
    )) {
      lockedAuthors.delete(ownerId);
    }
  }
  return toFeedPage(
    rows,
    limit,
    await media.listForPosts(rows.map((row) => row.id)),
    lockedAuthors,
    commentCounts
  );
}

export class ListFeed {
  constructor(
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  /**
   * `viewerId` is REQUIRED for `mengikuti` and, since Phase 6, READ ON BOTH
   * TABS: it is who the paywall gate is answered for, so `untuk-anda` is no
   * longer indifferent to it — a signed-out reader of `untuk-anda` sees every
   * gated post's caption and none of its images. The route is what enforces
   * the 401 for `mengikuti`, not this class — see `routes/posts.ts` for why
   * the two tabs differ in auth at all (`/beranda` is a publicly reachable
   * page).
   */
  async execute(input: {
    tab: FeedTab;
    viewerId: string | null;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    if (input.tab === "mengikuti") {
      if (input.viewerId === null) {
        throw new Error("ListFeed: mengikuti requires a viewer; the route must reject first");
      }
      const rows = await this.posts.listFollowing(input.viewerId, limit + 1, input.before);
      return paginate(this.media, this.subscriptions, this.clock, rows, limit, input.viewerId, NO_COMMENT_COUNTS);
    }
    const rows = await this.posts.listGlobal(limit + 1, input.before);
    return paginate(this.media, this.subscriptions, this.clock, rows, limit, input.viewerId, NO_COMMENT_COUNTS);
  }
}

export class ListUserPosts {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  /**
   * `viewerId` is REQUIRED rather than optional, and that is the whole point:
   * a profile page is publicly reachable, so the common case here is
   * `null`. An optional parameter would let a caller omit it and be handed
   * somebody's gated images by default — the same hazard `toPostView`'s
   * `locked` is required for. `null` is the caller saying "signed out", and
   * it locks every gated post on the page.
   */
  async execute(input: {
    handle: string;
    viewerId: string | null;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const user = await this.users.findByHandle(normalizeHandle(input.handle));
    if (!user) throw new NotFoundError("user not found");
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    const rows = await this.posts.listByAuthor(user.id, limit + 1, input.before);
    return paginate(this.media, this.subscriptions, this.clock, rows, limit, input.viewerId, NO_COMMENT_COUNTS);
  }
}

/**
 * One post, for DiscussionDetail. Answers for PERSONAL posts too, honouring
 * the paywall gate: one endpoint that applies the gate correctly is safer
 * than a community-only endpoint that never learns about it.
 *
 * A missing OR soft-deleted post is a `NotFoundError` — `getById` folds the
 * two together, filtering `deleted_at IS NULL` the same way every list path
 * does, so this class never has to know a post's deletion state.
 *
 * **The gate is not re-implemented here.** The single row is run through
 * `paginate` as a one-element page: it takes the identical two batched
 * queries and the identical per-row `locked` computation the feed does, so
 * "who may see a gated post's images" cannot drift between this endpoint and
 * the feed. `paginate` is unchanged for that — a one-row array is just its
 * ordinary input with `limit` 1. `commentCount` comes back `0`: the empty map
 * is the same one the personal feeds pass, DiscussionDetail renders the real
 * thread through `ListComments`, and this endpoint also answers personal
 * posts, whose count is always zero.
 */
export class GetPost {
  constructor(
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { postId: string; viewerId: string | null }): Promise<PostView> {
    const row = await this.posts.getById(input.postId);
    if (row === null) throw new NotFoundError("post not found");
    const page = await paginate(
      this.media,
      this.subscriptions,
      this.clock,
      [row],
      1,
      input.viewerId,
      NO_COMMENT_COUNTS
    );
    // `paginate` always returns a `posts` array of exactly this one kept row.
    return page.posts[0]!;
  }
}
