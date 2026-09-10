import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import {
  UserApiError,
  getCommunity,
  getPost,
  getSessionUser,
  listComments,
  type CommentView,
  type CommunityDetail,
  type PostView,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import CommentList from "./CommentList";
import PostCard from "./PostCard";
import Header from "./shell/Header";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; post: PostView; community: CommunityDetail };

/**
 * `/komunitas/:slug/diskusi/:postId` — one community post on its own page, with
 * its comment thread. The card on the Diskusi tab links here (ruling R11).
 *
 * **Two reads gate the page**, because `getPost` returns neither the community
 * slug nor any membership flag:
 * - `getPost(postId)` — the post body, author, type, media.
 * - `getCommunity(slug)` — `viewerIsMember` (gates the comment form) and
 *   `viewerIsOwner` (gates delete-on-every-comment).
 * An unknown post id OR an unknown slug is the shared `NotFoundPage`, the same
 * shape `CommunityPage` uses; any other failure is `errorCopy.ts` copy under
 * `role="alert"`. Loading, not-found and error are three separate early
 * returns.
 *
 * **The thread is this page's state**, seeded from `listComments(postId)`. A
 * submitted comment is appended (comments are oldest-first) and a deleted one
 * removed — both local, no refetch, the pattern `PostFeed` uses for posts. The
 * "N komentar" count is `comments.length`, never `getPost(...).commentCount`,
 * which that endpoint always returns as `0` (Task 5).
 */
export default function DiscussionPage() {
  const { slug, postId } = useParams<{ slug: string; postId: string }>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [comments, setComments] = useState<CommentView[]>([]);
  // Derived from the token this request carries, exactly like `CommunityPage`:
  // signing in in another tab must not leave a stale "no form" on screen.
  const signedIn = getSessionUser() !== null;

  useEffect(() => {
    if (slug === undefined || postId === undefined) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    Promise.all([getPost(postId), getCommunity(slug), listComments(postId)])
      .then(([post, community, thread]) => {
        if (cancelled) return;
        setLoad({ status: "ready", post, community });
        setComments(thread);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UserApiError && err.status === 404) {
          setLoad({ status: "not-found" });
          return;
        }
        setLoad({ status: "error", message: describeRequestFailure(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, postId, signedIn]);

  if (load.status === "loading") {
    return (
      <>
        <Header title="Diskusi" />
        <main className="user-page discussion-page">
          <p>Memuat...</p>
        </main>
      </>
    );
  }

  if (load.status === "not-found") {
    return <NotFoundPage />;
  }

  if (load.status === "error") {
    return (
      <>
        <Header title="Diskusi" />
        <main className="user-page discussion-page">
          {/* `form-error` (not `feed-error`): it has a bare rule in styles.css,
              and it is the class `CommunityPage` uses for this same early
              return. */}
          <p className="form-error" role="alert">
            {load.message}
          </p>
        </main>
      </>
    );
  }

  const { post, community } = load;

  return (
    <>
      <Header title="Diskusi" />
      <main className="user-page discussion-page">
        {/* Read-only here — the discussion page carries no post editing, so no
            `onEdit` / `onDeleteRequested` and `isOwn={false}`. */}
        <PostCard post={post} isOwn={false} />

        <section className="discussion-comments">
          <h2>{comments.length} komentar</h2>
          <CommentList
            postId={post.id}
            comments={comments}
            viewerIsMember={community.viewerIsMember === true}
            viewerIsOwner={community.viewerIsOwner}
            onSubmitted={(comment) => setComments((current) => [...current, comment])}
            onDeleted={(id) => setComments((current) => current.filter((c) => c.id !== id))}
          />
        </section>
      </main>
    </>
  );
}
