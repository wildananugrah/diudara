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
  /**
   * In `position` order. Empty — never absent — on a post with no images, so
   * the key set is stable.
   *
   * **EMPTY when this viewer is locked out** — never partial, and never a URL.
   * The id IS the URL here (`/users/media/:id` is derived from it, see
   * `MediaView`), so one id that survives a locked projection is one gated
   * image published to a stranger. A locked post and a post with no images are
   * told apart by `lockedMediaCount`, not by this field.
   */
  media: MediaView[];
  /**
   * On EVERY post, not only locked ones. The author and paying members are the
   * two people who never see a lock, and they are exactly the two who need to
   * know their post is gated — a conditional key would leave the client
   * unable to tell "not gated" from "gated, and you are in".
   */
  membersOnly: boolean;
  /**
   * How many images the lock is hiding. `0` whenever `media` is populated, so
   * `lockedMediaCount > 0` is precisely "there is something here you cannot
   * see". A count is not an id: it says how many, never which.
   */
  lockedMediaCount: number;
}

export interface FeedPage {
  posts: PostView[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
}

/**
 * The one `visibility` value that gates anything. `PostRow.visibility` is a
 * widened string so a new value needs no migration, which means a value this
 * file does not recognise — a typo, a future tier name — reads as NOT gated.
 * That is the safe direction only because the write path is the authority on
 * what may be stored; see `post-repository.port.ts`.
 *
 * EXPORTED so `read-posts.ts` decides which rows are gated using the very
 * value this file locks on. Two copies of the literal could drift, and the
 * drift would be silent in the dangerous direction: the gate would build a
 * set of locked authors that `toFeedPage` then never consults.
 */
export const MEMBERS_ONLY = "members";

function toMediaView(row: MediaRow): MediaView {
  return { id: row.id, width: row.width, height: row.height };
}

/**
 * `media` is REQUIRED rather than defaulted to `[]`: a default would let a new
 * call site forget it and silently publish every post as image-less, which is
 * indistinguishable in the response from a post that genuinely has none.
 * Passing `[]` explicitly is the caller saying it knows.
 *
 * `locked` is REQUIRED for the same reason, with a worse outcome (spec §8): a
 * forgotten default would publish gated media. It is the CALLER's answer to
 * "is this viewer entitled to this post's images" — this function does not
 * work it out, because it cannot: entitlement needs a viewer id and a
 * membership lookup, and both belong to the use case that already has them
 * (`read-posts.ts`). BARRIER ONE of two lives on this line; the media route
 * (spec §6.2) independently refuses an id it did not send, because a paying
 * member holds legitimate ids and can pass them on.
 */
export function toPostView(row: PostRow, media: MediaRow[], locked: boolean): PostView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
    media: locked ? [] : media.map(toMediaView),
    membersOnly: row.visibility === MEMBERS_ONLY,
    lockedMediaCount: locked ? media.length : 0,
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
 *
 * `lockedAuthors` names AUTHORS, not posts — one membership answer covers
 * every post that author has on the page, which is what makes the gate one
 * query per page rather than one per post. It is consulted TOGETHER with the
 * row's own `visibility`, never alone: an author with a gated post and a
 * public post on the same page is in that set because of the gated one, and
 * locking on membership alone would withhold the public post's images from
 * everybody.
 */
export function toFeedPage(
  rows: PostRow[],
  limit: number,
  media: MediaRow[],
  lockedAuthors: ReadonlySet<string>
): FeedPage {
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
    posts: kept.map((row) =>
      toPostView(
        row,
        byPost.get(row.id) ?? [],
        row.visibility === MEMBERS_ONLY && lockedAuthors.has(row.authorId)
      )
    ),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ timestamp: last.createdAt, id: last.id })
        : null,
  };
}
