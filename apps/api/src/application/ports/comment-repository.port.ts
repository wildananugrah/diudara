/**
 * One comment as the repository returns it: FLAT, with the author's public
 * fields joined in — the same rule `PostRow` follows. The nesting into
 * `{ author: { ... } }` happens in the view mapper, so the shape the wire sees
 * is decided in exactly one place.
 */
export interface CommentRow {
  id: string;
  body: string;
  /**
   * On the wire because the client renders a relative timestamp ("2 jam lalu")
   * next to every comment; the thread's ORDER is `listForPost`'s job, the
   * caller does not re-sort on this.
   */
  createdAt: Date;
  /**
   * Present for the same reason `PostRow.authorId` is: "may this viewer delete
   * this comment" is a question about ids, not handles. The view mapper still
   * picks its wire fields explicitly, which is what keeps this off the client.
   */
  authorId: string;
  authorHandle: string;
  authorDisplayName: string;
  /** `null` for a top-level comment; otherwise the top-level comment this is a reply to. Never a reply's own id — `CreateComment` flattens replies-to-replies before this is ever written. */
  parentId: string | null;
}

/** What a delete — or a reply's parent lookup — needs before it is allowed to proceed. */
export interface CommentOwnership {
  id: string;
  authorId: string;
  /**
   * The comment's post. The moderation rule "a post's author may delete any
   * comment on their post" reads this rather than issuing a second query, and
   * it is not answerable from `authorId` alone. `CreateComment` also uses it
   * to refuse a reply aimed at a comment on a DIFFERENT post.
   */
  postId: string;
  /**
   * `deletedAt !== null`. A soft-deleted comment still resolves here, so the
   * caller can tell "already gone" apart from "never existed" — the same
   * contract as the post repository's `ownershipOf`.
   */
  isDeleted: boolean;
  /** Same flattening field as `CommentRow.parentId` — `CreateComment` reads this to resolve a reply-to-a-reply onto its top-level ancestor. */
  parentId: string | null;
}

export interface CommentRepositoryPort {
  /**
   * Inserts one comment and returns it in the SAME projected shape every read
   * path uses. `parentId` is the ALREADY-FLATTENED top-level ancestor —
   * `CreateComment` resolves it before calling this, so nothing here needs to
   * re-check depth.
   */
  create(postId: string, authorId: string, body: string, parentId: string | null): Promise<CommentRow>;
  /**
   * Oldest first — a discussion thread reads top to bottom, the opposite of
   * the post feed's newest-first. Excludes soft-deleted comments. `limit` caps
   * the rows.
   */
  listForPost(postId: string, limit: number): Promise<CommentRow[]>;
  /** Live comment counts for a whole feed page, in ONE query. Missing ids mean zero. */
  countForPosts(postIds: string[]): Promise<Map<string, number>>;
  /**
   * `null` when the id has never existed. A soft-deleted comment still
   * resolves, with `isDeleted: true` — the same contract as the post's
   * `ownershipOf`.
   */
  ownershipOf(id: string): Promise<CommentOwnership | null>;
  /** Idempotent: deleting an already-deleted comment is a no-op, not an error — like the post's. */
  softDelete(id: string): Promise<void>;
}
