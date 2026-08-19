import { Link } from "react-router-dom";
import { mediaThumbUrl, type PostView } from "./apiClient";
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
  /**
   * **Raised on the TAP of `Hapus`, BEFORE anything has been deleted.** This
   * card does not call the API and does not confirm; it reports that the owner
   * asked to delete, and the caller decides what that means — `BerandaPage`
   * shows a confirmation, then sends the DELETE, then removes the row.
   *
   * It was called `onDeleted` until fix round 1, with a docstring that read
   * "the row is gone once this fires". That was false in both halves, and it is
   * exactly the sentence a second consumer would read and trust: wiring a list
   * removal straight to this callback deletes rows on screen that the server
   * was never asked about, and leaves them deleted when the DELETE fails.
   *
   * Told only the id, not the post — removing a row needs nothing else, and an
   * edit (which does need the body) has `onEdit` for it.
   */
  onDeleteRequested?: (id: string) => void;
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
export default function PostCard({ post, isOwn, now, onEdit, onDeleteRequested }: PostCardProps) {
  const clock = now ?? new Date();
  // Guarded, not read bare, even though `PostView.media` is documented as
  // required and never absent — see the comment on the media slot below for
  // why a version-skew deploy window makes that guarantee occasionally false.
  const media = post.media ?? [];

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

      {/* The feed loads THUMBNAILS only (`GET /users/media/:id/thumb`) — never
          the full-size image (spec §5.1: delivery proxies, thumbnails named
          as Phase 4's job; the media slot itself is §3): every byte is
          proxied through the API, and a feed of twenty posts pulling
          full-size images would be brutal on Indonesian mobile data.
          `data-count` is a pure styling hook (styles.css) for the 1/3/5-image
          layouts; it carries no behaviour of its own.

          `post.media` is read as `?? []`, not bare, even though `PostView`
          states the field is required and never absent (see its docstring in
          `apiClient.ts`). That contract holds for THIS branch's API. It does
          NOT hold for the several seconds of every deploy where the new web
          bundle (already serving `media`) is live against the still-running
          OLD api process (which has never heard of it) — `scripts/deploy.sh`
          swaps the bundle before reloading the API, and `apiFetch` does no
          runtime shape validation. A bare `.length` there is not a post
          without images, it is an uncaught render throw with no error
          boundary anywhere in this app — a blank `/beranda` and a blank
          profile page for every visitor until the reload finishes. The type
          stays honest about what a healthy API returns; this guard is for
          the minute it is not the current one. */}
      {media.length > 0 ? (
        <div className="post-card-media" data-count={media.length}>
          {media.map((image) => (
            <img
              key={image.id}
              src={mediaThumbUrl(image.id)}
              // From the media entry, not measured in the browser — this is
              // the whole reason `width`/`height` are columns on `post_media`
              // (spec §4): the row reserves its space before the byte arrives,
              // so the feed does not reflow under a reader's thumb as images
              // land.
              width={image.width}
              height={image.height}
              // No alt text in this phase (spec §12: honest limitations —
              // deliberately not smuggled into this phase). Inventing one from the
              // body would be worse than none — a screen reader would read the
              // caption twice — so this is empty on purpose, which marks the
              // image as decorative: the meaning is already in the text beside
              // it.
              alt=""
            />
          ))}
        </div>
      ) : null}

      {isOwn ? (
        <div className="post-card-actions">
          <button type="button" className="button-quiet" onClick={() => onEdit?.(post)}>
            Edit
          </button>
          <button type="button" className="button-quiet" onClick={() => onDeleteRequested?.(post.id)}>
            Hapus
          </button>
        </div>
      ) : null}
    </article>
  );
}
