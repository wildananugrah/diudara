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
  /**
   * `null` for a personal post — Beranda and profiles. Non-null for a
   * community post, which appears on that community's page and nowhere else
   * (schema `post.community_id`). The three personal read paths all filter
   * `community_id IS NULL`, so a row this projection returns for one of them
   * always has `communityId === null`; `listByCommunity` is where it is set.
   */
  communityId: string | null;
  /**
   * `diskusi` | `pengumuman` — a VARCHAR the schema widens without a
   * migration, exactly as `visibility` is. Always `diskusi` for a personal
   * post (schema `post.type`, and the `post_personal_has_no_type` CHECK).
   */
  type: string;
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
  /**
   * The CURRENT `public` | `members`, before this edit touches anything.
   * Task 5's `EditPost` needs it to compute the visibility the edit is
   * PRODUCING when the edit's own `visibility` is omitted — an omitted
   * `visibility` means "leave it exactly as it is", and this is the only
   * place that current value is available before the write happens.
   */
  visibility: string;
  /**
   * `null` for a personal post, the owning community's id otherwise. Phase 2
   * needs this here for two authorisation rules that both read
   * `ownershipOf`/`lockForEdit` rather than a new query: "the community's
   * owner may delete any post in their community", and "only a member of
   * the post's community may comment" — neither is answerable from
   * `authorId` alone.
   */
  communityId: string | null;
}

export interface PostRepositoryPort {
  /**
   * A SINGLE object parameter, not positionals. `visibility`, `communityId`
   * and `type` are all optional and, when omitted, leave the column at its
   * schema default (`public`, `NULL`, `diskusi` respectively). Positional
   * `(authorId, body, visibility?, communityId?, type?)` was rejected in
   * Phase 2: a fourth and fifth trailing string argument is exactly where a
   * caller silently passes `type` into `communityId`.
   */
  create(input: {
    authorId: string;
    body: string;
    visibility?: string;
    communityId?: string;
    type?: string;
  }): Promise<PostRow>;
  /** `null` when the id has never existed. A soft-deleted post still resolves, with `isDeleted: true`. */
  ownershipOf(id: string): Promise<PostOwnership | null>;
  /**
   * One post by id, in the SHARED projection — what `GetPost`
   * (`GET /users/posts/:id`) hands straight to the paywall gate.
   *
   * `null` when the id has never existed OR when the post is soft-deleted.
   * This is a READ path, so — unlike `ownershipOf`/`gatingOf`, which must
   * still answer for a deleted row — it filters `deleted_at IS NULL` exactly
   * as `listGlobal`/`listByAuthor`/`listByCommunity` do: a soft-deleted post
   * is unreachable through every projection, and the caller turns a `null`
   * from either cause into the same 404.
   */
  getById(id: string): Promise<PostRow | null>;
  /**
   * Task 5 fix round 1. Identical answer to `ownershipOf`, but taken under
   * `SELECT ... FOR UPDATE`: a row lock a caller holds for the rest of an
   * open transaction, so a SECOND call to `lockForEdit` on the SAME id — from
   * a concurrent edit — blocks until the first transaction commits or rolls
   * back. That is the entire mechanism behind "the resulting-state check
   * reads fresh data": the second edit's read happens strictly after the
   * first edit's write is visible, never before.
   *
   * MUST be called inside an open transaction (see `PostWriteUnitOfWorkPort`).
   * Called outside one, the lock is released the instant the statement
   * completes and buys no serialisation at all — `ownershipOf` above is the
   * right choice for every caller that does not need this guarantee
   * (`DeletePost`, and any read that is not about to write `visibility`).
   */
  lockForEdit(id: string): Promise<PostOwnership | null>;
  /**
   * The two fields `MediaEntitlement` gates on. `null` when the id has never
   * existed — which the gate treats as REFUSED, never as ungated: an image
   * whose post cannot be read is an image nobody can prove is public.
   *
   * A soft-deleted post still resolves, and still reports the visibility it
   * was deleted with. Deleting a post does not un-gate its images (spec §6.3).
   */
  gatingOf(id: string): Promise<PostGating | null>;
  /**
   * `null` if the post is missing or already deleted. Sets `edited_at`
   * unconditionally, on every call, visibility change or not.
   *
   * `visibility` is OPTIONAL: omitted means "leave the column exactly as it
   * is", never "reset it to public" — the same omitted-means-unchanged
   * contract `mediaIds` already carries at the route (`posts.ts:52`) and
   * `EditPost` carries here. Getting this backwards would silently un-gate
   * every post anyone edits without thinking about visibility.
   */
  updateBody(id: string, body: string, visibility?: string): Promise<PostRow | null>;
  /** Idempotent: deleting an already-deleted post is a no-op, not an error. */
  softDelete(id: string): Promise<void>;
  /** Newest first, across every author. Excludes deleted. Excludes community posts. */
  listGlobal(limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /**
   * Newest first, only authors `viewerId` follows. Excludes deleted. Excludes
   * the viewer's own. Excludes community posts.
   */
  listFollowing(viewerId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /** Newest first, one author. Excludes deleted. Excludes community posts. */
  listByAuthor(authorId: string, limit: number, before: KeysetCursor | null): Promise<PostRow[]>;
  /**
   * Newest first, one community's posts — the community feed's keyset page.
   * Excludes deleted. This is the ONLY read path that returns rows with a
   * non-null `communityId`.
   */
  listByCommunity(
    communityId: string,
    limit: number,
    before: KeysetCursor | null
  ): Promise<PostRow[]>;
}
