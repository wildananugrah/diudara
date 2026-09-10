import { DEFAULT_COMMENT_LIMIT } from "@diudara/shared";
import { ForbiddenError, NotFoundError } from "../errors";
import type { CommentRepositoryPort } from "../ports/comment-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import { toCommentView, type CommentView } from "./post-views";

/**
 * The thread under one community post, oldest first — the repository's
 * `listForPost` owns that order, and its projection already excludes
 * soft-deleted rows. A private fallback limit, the same shape `read-posts.ts`
 * and `community-feed.ts` keep their own: the route (Task 7) passes a parsed
 * one, so this only guards a direct call from a test or a future caller.
 */
export class ListComments {
  constructor(private readonly comments: CommentRepositoryPort) {}

  async execute(input: { postId: string; limit?: number }): Promise<CommentView[]> {
    const rows = await this.comments.listForPost(
      input.postId,
      input.limit ?? DEFAULT_COMMENT_LIMIT
    );
    return rows.map(toCommentView);
  }
}

/**
 * A comment on a community post. Every gate is about the POST, resolved once
 * through `posts.ownershipOf`:
 *
 *  - unknown post -> `NotFoundError`;
 *  - soft-deleted post -> `NotFoundError` (its thread is closed, and the id
 *    must not become an existence oracle for a deleted post);
 *  - then: a member of the post's community may comment, nobody else.
 *
 * A PERSONAL post (`communityId === null`) is refused with the SAME
 * `ForbiddenError` a non-member gets — it is NOT a special case. Nobody is a
 * member of "no community", so the membership check below is already the
 * correct and complete answer; the `!== null` guard here exists only because
 * `isMember`'s parameter is typed `string`. A future reader tempted to add
 * `if (post.communityId === null) throw ...` as its own branch: don't. That
 * would state the rule a second time and let the two copies drift.
 */
export class CreateComment {
  constructor(
    private readonly comments: CommentRepositoryPort,
    private readonly posts: PostRepositoryPort,
    private readonly communities: CommunityRepositoryPort
  ) {}

  async execute(input: {
    postId: string;
    authorId: string;
    body: string;
  }): Promise<CommentView> {
    const post = await this.posts.ownershipOf(input.postId);
    if (post === null) throw new NotFoundError("post not found");
    if (post.isDeleted) throw new NotFoundError("post not found");

    const member =
      post.communityId !== null &&
      (await this.communities.isMember(post.communityId, input.authorId));
    if (!member) {
      throw new ForbiddenError("hanya anggota komunitas yang boleh berkomentar");
    }

    return toCommentView(
      await this.comments.create(input.postId, input.authorId, input.body)
    );
  }
}

/**
 * Removing a comment. Its own author may always do it; failing that, the
 * owner of the community the comment's post belongs to may — the same
 * "moderation by removal" power `DeletePost` grants, reached the same way,
 * through the post's `communityId`. A personal post has no community and so
 * no such override.
 *
 * Idempotent, matching `DeletePost` and `CommentRepositoryPort.softDelete`:
 * a second delete of an already-deleted comment is a no-op that still returns
 * normally, never an error — `isDeleted` is not consulted here at all.
 */
export class DeleteComment {
  constructor(
    private readonly comments: CommentRepositoryPort,
    private readonly posts: PostRepositoryPort,
    private readonly communities: CommunityRepositoryPort
  ) {}

  async execute(input: { commentId: string; deleterId: string }): Promise<void> {
    const comment = await this.comments.ownershipOf(input.commentId);
    if (comment === null) throw new NotFoundError("comment not found");

    if (comment.authorId !== input.deleterId) {
      // Not the author — the only other person allowed is the community
      // owner. Resolve the post to its community id, the community to its
      // owner. A missing post, a personal post (null `communityId`), or a
      // community whose owner is someone else all fall through to the refusal.
      const post = await this.posts.ownershipOf(comment.postId);
      const community =
        post !== null && post.communityId !== null
          ? await this.communities.findById(post.communityId)
          : null;
      if (community === null || community.ownerId !== input.deleterId) {
        throw new ForbiddenError(
          "hanya penulis atau pemilik komunitas yang boleh menghapus komentar"
        );
      }
    }

    await this.comments.softDelete(input.commentId);
  }
}
