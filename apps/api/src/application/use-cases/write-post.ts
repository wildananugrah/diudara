import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import { toPostView, type PostView } from "./post-views";

export { MAX_POST_BODY_LENGTH };

const EMPTY_MESSAGE = "kiriman tidak boleh kosong";
const TOO_LONG_MESSAGE = `kiriman maksimal ${MAX_POST_BODY_LENGTH} karakter`;
const NOT_YOURS_MESSAGE = "kiriman ini bukan milik Anda";

/**
 * Trims, then validates. In that order deliberately: a body of three spaces is
 * empty, and validating before trimming would accept it.
 */
function requireBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError(EMPTY_MESSAGE);
  if (body.length > MAX_POST_BODY_LENGTH) throw new ValidationError(TOO_LONG_MESSAGE);
  return body;
}

export class CreatePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  async execute(input: { authorId: string; body: string }): Promise<PostView> {
    const row = await this.posts.create(input.authorId, requireBody(input.body));
    return toPostView(row);
  }
}

export class EditPost {
  constructor(private readonly posts: PostRepositoryPort) {}

  async execute(input: { editorId: string; postId: string; body: string }): Promise<PostView> {
    const body = requireBody(input.body);
    // Ownership BEFORE the write, and a 403 that does not reveal the body:
    // returning 404 for someone else's post would make the id an existence
    // oracle, and 403 on a post you cannot see reveals nothing you could not
    // learn from the feed, where every post is public in this phase.
    const owned = await this.requireOwn(input.postId, input.editorId);
    if (owned.isDeleted) throw new NotFoundError("post not found");
    const row = await this.posts.updateBody(input.postId, body);
    if (row === null) throw new NotFoundError("post not found");
    return toPostView(row);
  }

  private async requireOwn(postId: string, actorId: string) {
    const owned = await this.posts.ownershipOf(postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== actorId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    return owned;
  }
}

export class DeletePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  /**
   * Idempotent: deleting an already-deleted post returns normally. A button that
   * errors when the state already matches what you asked for is worse than one
   * that agrees — the same ruling follow/unfollow made.
   */
  async execute(input: { deleterId: string; postId: string }): Promise<void> {
    const owned = await this.posts.ownershipOf(input.postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== input.deleterId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    await this.posts.softDelete(input.postId);
  }
}
