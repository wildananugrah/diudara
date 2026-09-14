import { useState, type FormEvent } from "react";
import { MAX_COMMENT_BODY_LENGTH } from "@diudara/shared";
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
 * Splits the flat, oldest-first list into one level: top-level comments (and
 * replies whose target is gone — a deleted parent excludes itself from
 * `comments`, per `listForPost`, so its replies would otherwise vanish too)
 * plus, per top-level id, its replies in original order. The server already
 * flattens a reply-to-a-reply onto its top-level ancestor
 * (`CreateComment.resolveParentId`), so no `parentId` here ever names
 * something that is itself a reply.
 */
function groupComments(comments: CommentView[]): {
  topLevel: CommentView[];
  replies: Map<string, CommentView[]>;
} {
  const topIds = new Set(comments.filter((c) => c.parentId === null).map((c) => c.id));
  const topLevel: CommentView[] = [];
  const replies = new Map<string, CommentView[]>();
  for (const comment of comments) {
    const parentId = comment.parentId !== null && topIds.has(comment.parentId) ? comment.parentId : null;
    if (parentId === null) {
      topLevel.push(comment);
    } else {
      const list = replies.get(parentId);
      if (list) list.push(comment);
      else replies.set(parentId, [comment]);
    }
  }
  return { topLevel, replies };
}

/**
 * The comment thread under a discussion, plus the member-only box that adds to
 * it. Presentational apart from the three writes it makes on its own — a
 * top-level submit, a reply submit, and a delete — each of which reports the
 * result up so the parent's list stays the single source of truth.
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
  // The comment currently showing its inline reply form — one at a time, matching how a single `body`/`submitting` pair already work for the top-level form.
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replySubmitting, setReplySubmitting] = useState(false);

  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_COMMENT_BODY_LENGTH && !submitting;

  const trimmedReply = replyBody.trim();
  const canSubmitReply =
    trimmedReply.length > 0 && trimmedReply.length <= MAX_COMMENT_BODY_LENGTH && !replySubmitting;

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

  async function handleReplySubmit(event: FormEvent, parentId: string): Promise<void> {
    event.preventDefault();
    if (!canSubmitReply) return;
    setReplySubmitting(true);
    setError(null);
    try {
      const created = await createComment(postId, trimmedReply, parentId);
      onSubmitted(created);
      setReplyBody("");
      setReplyingTo(null);
    } catch (err: unknown) {
      setError(describeRequestFailure(err));
    } finally {
      setReplySubmitting(false);
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

  function renderComment(comment: CommentView) {
    return (
      <>
        <p className="comment-identity">
          <span className="comment-name">{comment.author.displayName}</span>{" "}
          <span className="comment-handle muted">@{comment.author.handle}</span>
        </p>
        {/* Plain text node — a comment body is untrusted input from any
            signed-up user; never dangerouslySetInnerHTML. */}
        <p className="comment-body">{comment.body}</p>
        <div className="comment-row-actions">
          {viewerIsMember ? (
            <button
              type="button"
              className="button-quiet"
              onClick={() => {
                setReplyingTo(comment.id);
                setReplyBody("");
              }}
            >
              Balas
            </button>
          ) : null}
          {viewerIsOwner || isOwnHandle(comment.author.handle) ? (
            <button
              type="button"
              className="button-quiet"
              onClick={() => void handleDelete(comment.id)}
            >
              Hapus
            </button>
          ) : null}
        </div>
        {replyingTo === comment.id ? (
          <form
            className="comment-form comment-reply-form"
            onSubmit={(event) => void handleReplySubmit(event, comment.id)}
          >
            <textarea
              className="comment-form-body"
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value.slice(0, MAX_COMMENT_BODY_LENGTH))}
              maxLength={MAX_COMMENT_BODY_LENGTH}
              placeholder="Tulis balasan"
              aria-label={`Balas ${comment.author.displayName}`}
              rows={2}
            />
            <div className="comment-form-actions">
              <button type="submit" className="button-primary btn btn-sm" disabled={!canSubmitReply}>
                Kirim
              </button>
              <button type="button" className="button-quiet" onClick={() => setReplyingTo(null)}>
                Batal
              </button>
            </div>
          </form>
        ) : null}
      </>
    );
  }

  const { topLevel, replies } = groupComments(comments);

  return (
    <div className="comment-list">
      {viewerIsMember ? (
        <form className="comment-form" onSubmit={handleSubmit}>
          <textarea
            className="comment-form-body"
            value={body}
            onChange={(event) => setBody(event.target.value.slice(0, MAX_COMMENT_BODY_LENGTH))}
            maxLength={MAX_COMMENT_BODY_LENGTH}
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

      {topLevel.length === 0 ? (
        <p className="empty">Belum ada komentar.</p>
      ) : (
        <ul className="comment-thread">
          {topLevel.map((comment) => {
            const commentReplies = replies.get(comment.id) ?? [];
            return (
              <li className="comment-row" key={comment.id}>
                {renderComment(comment)}
                {commentReplies.length > 0 ? (
                  <ul className="comment-replies">
                    {commentReplies.map((reply) => (
                      <li className="comment-row comment-reply" key={reply.id}>
                        {renderComment(reply)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

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
