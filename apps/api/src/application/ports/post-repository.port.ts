import type { KeysetCursor } from "../../domain/keyset-cursor";

/**
 * One post as the repository returns it: FLAT, with the author's public fields
 * joined in. The nesting into `{ author: { ... } }` happens in `post-views.ts`,
 * so the shape the wire sees is decided in exactly one place.
 *
 * `authorId` is deliberately ABSENT — nothing outside the ownership check needs
 * it, and a row shape that carries it is one `c.json(row)` away from leaking it.
 */
export interface PostRow {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  authorHandle: string;
  authorDisplayName: string;
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
