import { encodeKeysetCursor } from "../../domain/keyset-cursor";
import type { PostRow } from "../ports/post-repository.port";

/**
 * A post as the wire sees it. The nesting happens HERE and nowhere else, so
 * "what a post looks like to a client" has one definition.
 */
export interface PostView {
  id: string;
  body: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null on an unedited post — explicitly null, never absent, so the key set is stable. */
  editedAt: string | null;
  author: { handle: string; displayName: string };
}

export interface FeedPage {
  posts: PostView[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
}

export function toPostView(row: PostRow): PostView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
  };
}

/**
 * Turns `limit + 1` rows into a page of at most `limit`.
 *
 * THE PROBE ROW IS WHY: asking for one more than we intend to return is the only
 * way `nextCursor === null` can mean "there is nothing after this" rather than
 * "this page happened to come back full". Without it, every exhausted feed shows
 * a "Muat lebih banyak" button that fetches an empty page.
 */
export function toFeedPage(rows: PostRow[], limit: number): FeedPage {
  const kept = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = kept[kept.length - 1];
  return {
    posts: kept.map(toPostView),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ timestamp: last.createdAt, id: last.id })
        : null,
  };
}
