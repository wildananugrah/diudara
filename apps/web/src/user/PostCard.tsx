import { Link } from "react-router-dom";
import type { PostView } from "./apiClient";
import { formatRelativeTime } from "./relativeTime";

export interface PostCardProps {
  post: PostView;
  /** Whether the SIGNED-IN viewer authored this post — never guessed from a handle comparison here; the caller (the feed) already knows whose posts it asked for. Gates the Edit/Hapus controls, and ONLY those. */
  isOwn: boolean;
  /**
   * Injected clock for `formatRelativeTime`, same reason as everywhere else on
   * this project: a card that reads `Date.now()` itself cannot be tested at a
   * boundary. Defaults to the real clock so callers outside a test don't have
   * to pass one.
   */
  now?: Date;
  /** Told the FULL post, since editing needs the current body to pre-fill a form — not just the id. */
  onEdit?: (post: PostView) => void;
  /** Told only the id: the row is gone once this fires, and that is all a caller removing it from a list needs. */
  onDeleted?: (id: string) => void;
}

/**
 * One post, rendered read-only apart from the two owner controls. Deliberately
 * carries no `viewerFollows` and renders no follow affordance at all — Phase
 * 2's carry-forward named this exact component as where that field gets
 * guessed back into existence (`signedIn ? false : null`) the moment a follow
 * button looks tempting to add beside an author's name. It is not tempting
 * here: this card does not know anything about the viewer's relationship to
 * the author, only that `isOwn` tells it whether the viewer IS the author.
 *
 * `isOwn` gates BOTH the Edit and Hapus controls together, as one condition —
 * there is no world in which a viewer may edit a post they may not delete, or
 * the reverse, so a single guard is the honest shape rather than two that
 * could drift apart.
 */
export default function PostCard({ post, isOwn, now, onEdit, onDeleted }: PostCardProps) {
  const clock = now ?? new Date();

  return (
    <article className="post-card">
      <header className="post-card-header">
        <Link to={`/@${post.author.handle}`} className="post-card-identity">
          <span className="post-card-name">{post.author.displayName}</span>
          <span className="post-card-handle">@{post.author.handle}</span>
        </Link>
        <span className="post-card-meta">
          {formatRelativeTime(post.createdAt, clock)}
          {post.editedAt !== null ? " · diedit" : ""}
        </span>
      </header>

      {/* Never dangerouslySetInnerHTML: post.body is untrusted input from any
          signed-up user. white-space: pre-wrap in styles.css preserves line
          breaks from this plain text node without parsing anything as markup. */}
      <p className="post-card-body">{post.body}</p>

      {isOwn ? (
        <div className="post-card-actions">
          <button type="button" className="button-quiet" onClick={() => onEdit?.(post)}>
            Edit
          </button>
          <button type="button" className="button-quiet" onClick={() => onDeleted?.(post.id)}>
            Hapus
          </button>
        </div>
      ) : null}
    </article>
  );
}
