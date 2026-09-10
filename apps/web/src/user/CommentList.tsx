import { useState, type FormEvent } from "react";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import {
  createComment,
  deleteComment,
  isOwnHandle,
  type CommentView,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";

interface Props {
  postId: string;
  /**
   * The thread, oldest-first, exactly as `listComments` returns it. **Owned by
   * the parent** (`DiscussionPage`): this component reads it, never stores it.
   * A successful submit calls `onSubmitted(newComment)` and a successful delete
   * calls `onDeleted(id)`; the parent appends / removes, and there is no
   * refetch — the same one-owner rule `PostFeed` follows for posts.
   */
  comments: CommentView[];
  /**
   * `true` only for a signed-in member of the community. A non-member and a
   * signed-out visitor both get `false` and see no form — never a disabled one.
   * `DiscussionPage` collapses `CommunityDetail.viewerIsMember` (`boolean |
   * null`) to this boolean.
   */
  viewerIsMember: boolean;
  /** The community owner deletes any comment; `CommentView` carries no `authorId`, so per-comment authorship is `isOwnHandle(comment.author.handle)`. */
  viewerIsOwner: boolean;
  onSubmitted: (comment: CommentView) => void;
  onDeleted: (id: string) => void;
}

/**
 * The comment thread under a discussion, plus the member-only box that adds to
 * it. Presentational apart from the two writes it makes on its own — a submit
 * and a delete — each of which reports the result up so the parent's list stays
 * the single source of truth.
 */
export default function CommentList({
  postId,
  comments,
  viewerIsMember,
  viewerIsOwner,
  onSubmitted,
  onDeleted,
}: Props) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_POST_BODY_LENGTH && !submitting;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createComment(postId, trimmed);
      onSubmitted(created);
      setBody("");
    } catch (err: unknown) {
      // Never `err.message` — see `errorCopy.ts` and `no-raw-server-errors.test.ts`.
      setError(describeRequestFailure(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setError(null);
    try {
      await deleteComment(id);
      onDeleted(id);
    } catch (err: unknown) {
      setError(describeRequestFailure(err));
    }
  }

  return (
    <div className="comment-list">
      {comments.length === 0 ? (
        <p className="empty">Belum ada komentar.</p>
      ) : (
        <ul className="comment-thread">
          {comments.map((comment) => (
            <li className="comment-row" key={comment.id}>
              <p className="comment-identity">
                <span className="comment-name">{comment.author.displayName}</span>{" "}
                <span className="comment-handle muted">@{comment.author.handle}</span>
              </p>
              {/* Plain text node — a comment body is untrusted input from any
                  signed-up user; never dangerouslySetInnerHTML. */}
              <p className="comment-body">{comment.body}</p>
              {viewerIsOwner || isOwnHandle(comment.author.handle) ? (
                <button
                  type="button"
                  className="button-quiet"
                  onClick={() => void handleDelete(comment.id)}
                >
                  Hapus
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {viewerIsMember ? (
        <form className="comment-form" onSubmit={handleSubmit}>
          <textarea
            className="comment-form-body"
            value={body}
            onChange={(event) => setBody(event.target.value.slice(0, MAX_POST_BODY_LENGTH))}
            maxLength={MAX_POST_BODY_LENGTH}
            placeholder="Tulis komentar"
            aria-label="Tulis komentar"
            rows={3}
          />
          <div className="comment-form-actions">
            <button type="submit" className="button-primary btn btn-sm" disabled={!canSubmit}>
              Kirim
            </button>
          </div>
        </form>
      ) : null}

      {/* `role="alert"` matches every other request-failure element under
          src/user — FollowButton, LoginPage, PostFeed, PostComposer. */}
      {error !== null ? (
        <p className="comment-list-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
