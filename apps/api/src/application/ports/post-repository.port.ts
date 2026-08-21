import type { KeysetCursor } from "../../domain/keyset-cursor";

/**
 * One post as the repository returns it: FLAT, with the author's public fields
 * joined in. The nesting into `{ author: { ... } }` happens in `post-views.ts`,
 * so the shape the wire sees is decided in exactly one place.
 *
 * `authorId` IS present — entitlement (a gated post) is a question about ids,
 * not handles, so the gate cannot be built without it here. `toPostView` in
 * `post-views.ts` still picks its wire fields explicitly, which is what keeps
 * it from leaking onto the client.
 */
export interface PostRow {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  authorId: string;
  /** `public` | `members`. Widened here rather than in the DB so a new value needs no migration. */
  visibility: string;
  authorHandle: string;
  authorDisplayName: string;
}

/**
 * What BARRIER TWO needs to know about the post an image hangs on (spec
 * §6.2): who wrote it, and whether it is gated.
 *
 * Deliberately NOT folded into `PostOwnership` below. That type answers "may
 * this editor proceed" and carries `isDeleted` for it; this one answers "may
 * this viewer see these bytes" and must NOT read `isDeleted`, because §6.3
 * settles that the media route keeps serving a soft-deleted post's images
 * exactly as it does today. One type carrying both questions is one field a
 * future reader would apply to the wrong one.
 */
export interface PostGating {
  authorId: string;
  /** `public` | `members` — the same widened string `PostRow.visibility` carries. */
  visibility: string;
}

/** What an edit or delete needs before it is allowed to proceed. */
export interface PostOwnership {
  id: string;
  authorId: string;
  isDeleted: boolean;
}

export interface PostRepositoryPort {
  create(authorId: string, body: string): Promise<PostRow>;
  /** `null` when the id has never existed. A soft-deleted post still resolves, with `isDeleted: true`. */
  ownershipOf(id: string): Promise<PostOwnership | null>;
  /**
   * The two fields `MediaEntitlement` gates on. `null` when the id has never
   * existed — which the gate treats as REFUSED, never as ungated: an image
   * whose post cannot be read is an image nobody can prove is public.
   *
   * A soft-deleted post still resolves, and still reports the visibility it
   * was deleted with. Deleting a post does not un-gate its images (spec §6.3).
   */
  gatingOf(id: string): Promise<PostGating | null>;
  /** `null` if the post is missing or already deleted. Sets `edited_at`. */
  updateBody(id: string, body: string): Promise<PostRow | null>;
  /** Idempotent: deleting an already-deleted post is a no-op, not an error. */
  softDelete(id: string): Promise<void>;
  /** Newest first, across every author. Excludes deleted. */
  listGlobal(limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /** Newest first, only authors `viewerId` follows. Excludes deleted. Excludes the viewer's own. */
  listFollowing(viewerId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /** Newest first, one author. Excludes deleted. */
  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
}
