import { encodeKeysetCursor } from "../../domain/keyset-cursor";
import type { MediaRow } from "../ports/media-repository.port";
import type { PostRow } from "../ports/post-repository.port";

/**
 * One image on a post, as the wire sees it. EXACTLY three fields: the media
 * row also carries `ownerId`, `postId`, `position` and `byteSize`, and none of
 * those is a client's business — `ownerId` would say who uploaded an image
 * independently of who posted it, and the rest is bookkeeping. There is no
 * URL and no bucket key here either: the id is the only identifier that ever
 * leaves this process, and `/users/media/:id` is derived from it (spec §4).
 *
 * `width` and `height` are the ones `PostCard` needs to reserve space, so the
 * feed does not reflow as images land.
 */
export interface MediaView {
  id: string;
  width: number;
  height: number;
}

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
  /** In `position` order. Empty — never absent — on a post with no images, so the key set is stable. */
  media: MediaView[];
}

export interface FeedPage {
  posts: PostView[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
}

function toMediaView(row: MediaRow): MediaView {
  return { id: row.id, width: row.width, height: row.height };
}

/**
 * `media` is REQUIRED rather than defaulted to `[]`: a default would let a new
 * call site forget it and silently publish every post as image-less, which is
 * indistinguishable in the response from a post that genuinely has none.
 * Passing `[]` explicitly is the caller saying it knows.
 */
export function toPostView(row: PostRow, media: MediaRow[]): PostView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
    media: media.map(toMediaView),
  };
}

/**
 * Turns `limit + 1` rows into a page of at most `limit`.
 *
 * THE PROBE ROW IS WHY: asking for one more than we intend to return is the only
 * way `nextCursor === null` can mean "there is nothing after this" rather than
 * "this page happened to come back full". Without it, every exhausted feed shows
 * a "Muat lebih banyak" button that fetches an empty page.
 *
 * `media` arrives as ONE flat list for the whole page — `listForPosts` is a
 * single query, not one per row — so the grouping happens here. The caller
 * cannot pre-group it without duplicating the probe-row logic below, which is
 * why the list it passes covers every row it fetched INCLUDING the probe;
 * media belonging to a row that does not survive the slice is dropped with it.
 */
export function toFeedPage(rows: PostRow[], limit: number, media: MediaRow[]): FeedPage {
  const kept = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = kept[kept.length - 1];
  const byPost = new Map<string, MediaRow[]>();
  for (const row of media) {
    if (row.postId === null) continue;
    const existing = byPost.get(row.postId);
    if (existing === undefined) byPost.set(row.postId, [row]);
    else existing.push(row);
  }
  return {
    posts: kept.map((row) => toPostView(row, byPost.get(row.id) ?? [])),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ timestamp: last.createdAt, id: last.id })
        : null,
  };
}
