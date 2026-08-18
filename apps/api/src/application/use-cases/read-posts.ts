import { NotFoundError } from "../errors";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { PostRepositoryPort, PostRow } from "../ports/post-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import { normalizeHandle } from "../../domain/handle";
import { toFeedPage, type FeedPage } from "./post-views";

/**
 * The fallback when a caller passes no limit. `routes/posts.ts` always passes one,
 * so this only guards a direct call from a test or a future caller.
 */
const DEFAULT_FEED_PAGE_SIZE = 20;

export type FeedTab = "untuk-anda" | "mengikuti";

/**
 * Attaches the page's images with ONE query for the whole page. A per-post
 * lookup would be 20 round trips per feed page, which is why
 * `listForPosts` exists at all.
 *
 * The media is fetched for every row the repository returned, INCLUDING the
 * probe row: `toFeedPage` is what knows which rows survive the slice, and it
 * drops the probe's media along with the probe. Fetching for one extra post is
 * cheaper than teaching this function the probe-row rule a second time.
 */
async function pageWithMedia(
  media: MediaRepositoryPort,
  rows: PostRow[],
  limit: number
): Promise<FeedPage> {
  return toFeedPage(rows, limit, await media.listForPosts(rows.map((row) => row.id)));
}

export class ListFeed {
  constructor(
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort
  ) {}

  /**
   * `viewerId` is REQUIRED for `mengikuti` and unused for `untuk-anda`. The route
   * is what enforces the 401, not this class — see `routes/posts.ts` for why the
   * two tabs differ in auth at all (`/beranda` is a publicly reachable page).
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
      return pageWithMedia(this.media, rows, limit);
    }
    const rows = await this.posts.listGlobal(limit + 1, input.before);
    return pageWithMedia(this.media, rows, limit);
  }
}

export class ListUserPosts {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort
  ) {}

  async execute(input: {
    handle: string;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const user = await this.users.findByHandle(normalizeHandle(input.handle));
    if (!user) throw new NotFoundError("user not found");
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    const rows = await this.posts.listByAuthor(user.id, limit + 1, input.before);
    return pageWithMedia(this.media, rows, limit);
  }
}
