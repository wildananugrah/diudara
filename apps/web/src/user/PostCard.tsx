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
  /**
   * **Task 8.** Rendered as a link ("N komentar") to the post's own discussion
   * page. Absent on Beranda and profiles, where there is no discussion page —
   * so nothing new renders there, which is what keeps those feeds unchanged.
   */
  detailHref?: string;
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
export default function PostCard({
  post,
  isOwn,
  now,
  onEdit,
  onDeleteRequested,
  detailHref,
}: PostCardProps) {
  const clock = now ?? new Date();
  // Guarded, not read bare, even though `PostView.media` is documented as
  // required and never absent — see the comment on the media slot below for
  // why a version-skew deploy window makes that guarantee occasionally false.
  const media = post.media ?? [];
  // Locked is `lockedMediaCount > 0`, NOT `membersOnly` and NOT
  // `media.length === 0`. `membersOnly` is `true` on every members-only post
  // including the ones THIS viewer can see (the author's own, and a paying
  // member's) — see `PostView.membersOnly`'s own docstring. And an ordinary
  // post with no photos also has `media: []`. `lockedMediaCount` is the one
  // field the API sets to mean exactly "there is something here you cannot
  // see" (`toPostView`'s docstring in `apps/api`). Guarded with `?? 0` for
  // the same version-skew deploy window as `media` above — `undefined > 0`
  // would already be `false`, but the guard keeps the reasoning visible
  // rather than relying on an implicit coercion.
  const lockedCount = post.lockedMediaCount ?? 0;
  const locked = lockedCount > 0;

  /**
   * **Task 8 — the bug the user actually reported.** The lock CTA used to be
   * unconditionally `<Link to="/@handle">`. On the author's OWN profile that
   * link target IS the page already on screen, so the click did nothing at
   * all — no navigation, no error, nothing for the reader to even suspect
   * went wrong. It read fine in review because nobody clicked it while
   * standing on that exact profile.
   *
   * The fix is in the CTA's own `onClick`, fifty lines below, and that
   * comment is the one to read. This block previously described a RENDER-time
   * check (`membershipOfferOnPage`, computed here from
   * `document.getElementById`) which was replaced before this branch shipped,
   * because reading the DOM during React's render phase answers "no offer
   * here" for any sibling mounting in the same pass — reintroducing the exact
   * dead link above. The variable it described no longer exists.
   *
   * Left as a pointer rather than deleted outright: whole-branch review M-3
   * found the stale version still sitting here, contradicting the live comment
   * below in capitals, and inviting the next reader to "restore" the bug.
   *
   * KNOWN GAP (spec §7, review M-4): the CTA still reads "Jadi anggota untuk
   * melihat" — it PROMISES a membership. `PostView.author` carries no signal
   * about whether that person offers one, so a creator who withdraws every
   * tier while keeping gated posts leaves this CTA pointing at a profile with
   * no offer on it, where the click is a no-op again. Task 8 dropped the
   * `offersMembership` field and its test together rather than half-build it;
   * what it did NOT do — and what was wrongly reported as done — is soften
   * this sentence to something `PostView` can prove.
   */
  return (
    <article className="post-card" data-testid="post-card">
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

      {/* Task 8: a `pengumuman` reads as a distinct card in the ordinary
          chronological feed (spec §"Announcements are not pinned") — a
          `diskusi` and every personal post carry no badge. */}
      {post.type === "pengumuman" ? (
        <p className="post-card-type-badge">Pengumuman</p>
      ) : null}

      {/* Never dangerouslySetInnerHTML: post.body is untrusted input from any
          signed-up user. white-space: pre-wrap in styles.css preserves line
          breaks from this plain text node without parsing anything as markup. */}
      <p className="post-card-body">{post.body}</p>

      {/* The feed loads THUMBNAILS only (`GET /users/media/:id/thumb`) — never
          the full-size image (spec §5.1 is why delivery PROXIES; the media
          slot itself and "thumbnails are Phase 4's job" are both §2): every byte is
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
      {locked ? (
        // The lock panel — the conversion surface (spec §5, §5.1; design §8).
        // Carries ONLY the count and a link to the author's profile. No `img`,
        // no `src`, no id from `post.media` (it is `[]` for a locked post by
        // the API's own construction) — there is no media URL anywhere in
        // this branch for a future edit to accidentally wire up. The link
        // target is `/@handle`, the SAME shape every other in-app profile
        // link uses (the identity link above, `FollowListPage`, `JelajahPage`)
        // and the only shape `ProfilePage`'s route actually accepts — see
        // that file's own docstring on why a bare handle 404s. Phase 5a's
        // membership offer and "Jadi anggota" button already live there
        // (spec §6); this is deliberately not a second payment surface.
        <div className="post-card-locked">
          <p className="post-card-locked-count">{lockedCount} foto terkunci</p>
          {/*
            Task 8's judgement call, recorded here because this is exactly
            where the next reader meets its absence: the brief's third test
            wanted this CTA to say nothing when the author offers NO tier at
            all (a withdrawn or never-published offer), rather than promise a
            membership door that does not exist. Proving that needs a signal
            THIS post cannot carry — `PostView.author` has no
            "does this author sell anything" field, and never could without
            widening `apps/api`'s author projection (`post-views.ts`) and its
            own closed-shape assertion, which six prior tasks deliberately
            closed. Task 8 is WEB ONLY. Rather than add an API field to chase
            one test, the CTA below says only what it can already prove from
            `PostView` alone: "this photo is gated", never "there is a
            membership to buy" — it names the fact (locked), not the
            (unverifiable) remedy. The scroll-vs-link fix right below is
            unaffected: it changes WHERE the same sentence points, not
            whether the sentence is true.
          */}
          {/*
            ALWAYS a <Link>, and the scroll-vs-navigate decision is made AT CLICK
            TIME, not at render time.

            Deciding at render meant reading `document.getElementById` during
            React's render phase, before siblings mounting in the same pass have
            been committed to the DOM. On a profile page's FIRST pass the offer
            does not exist yet, so the check answered "not on this page" and the
            CTA silently became a plain link back to the page you are already
            standing on — the exact bug this task exists to fix, returning
            whenever posts and the offer happen to render in one pass. It works
            by accident today only because posts arrive asynchronously, in a
            LATER pass than the offer. No test could catch it either: a test
            that appends the offer element before rendering controls the very
            ordering the browser does not.

            At click time the DOM is settled and the question has a real answer.
            Kept as a link rather than a button so middle-click, copy-link and
            open-in-new-tab still work on the feed, where navigating IS the
            right behaviour; `preventDefault` only fires when there is somewhere
            better to go.
          */}
          <Link
            to={`/@${post.author.handle}`}
            className="post-card-locked-link"
            onClick={(event) => {
              const offer = document.getElementById("membership-offer");
              if (offer === null) return; // not on this page — let it navigate
              event.preventDefault();
              offer.scrollIntoView({ block: "center" });
            }}
          >
            Jadi anggota untuk melihat
          </Link>
        </div>
      ) : media.length > 0 ? (
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

      {/* Task 8: only the community feed passes `detailHref` (the discussion
          route). Beranda and profiles pass nothing, so this renders nowhere
          on them — the count itself is `post.commentCount`, guarded because
          the field is optional on `PostView` for the fixtures' sake. */}
      {detailHref !== undefined ? (
        <Link to={detailHref} className="post-card-comments">
          {post.commentCount ?? 0} komentar
        </Link>
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
