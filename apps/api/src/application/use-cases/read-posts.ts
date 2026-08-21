import { NotFoundError } from "../errors";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type { ClockPort } from "../ports/clock.port";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { PostRepositoryPort, PostRow } from "../ports/post-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import { normalizeHandle } from "../../domain/handle";
import { toFeedPage, type FeedPage } from "./post-views";

/**
 * The fallback when a caller passes no limit. `routes/posts.ts` always passes one,
 * so this only guards a direct call from a test or a future caller.
 */
const DEFAULT_FEED_PAGE_SIZE = 20;

export type FeedTab = "untuk-anda" | "mengikuti";

/** The one `visibility` value that gates a post. Mirrors `post-views.ts`. */
const MEMBERS_ONLY = "members";

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
 * author nor a currently-paying member. The set starts as every gated author
 * on the page and memberships are REMOVED from it, so the failure direction of
 * a bug here — a missing row, a query that answers nothing — is locked out,
 * never let in.
 *
 * A signed-out viewer (`viewerId === null`) skips the query entirely: there is
 * no subscriber id to ask about, and the only answer such a query could have
 * is the one this set already holds.
 */
async function paginate(
  media: MediaRepositoryPort,
  subscriptions: UserSubscriptionRepositoryPort,
  clock: ClockPort,
  rows: PostRow[],
  limit: number,
  viewerId: string | null
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
    lockedAuthors
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
      return paginate(this.media, this.subscriptions, this.clock, rows, limit, input.viewerId);
    }
    const rows = await this.posts.listGlobal(limit + 1, input.before);
    return paginate(this.media, this.subscriptions, this.clock, rows, limit, input.viewerId);
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
    return paginate(this.media, this.subscriptions, this.clock, rows, limit, input.viewerId);
  }
}
