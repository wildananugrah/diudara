import { useCallback, useEffect, useState } from "react";
import PostCard from "./PostCard";
import { describeRequestFailure } from "./errorCopy";
import type { FeedPage, PostView } from "./apiClient";

interface Props {
  /** `null` means "the first page". Identity matters: a changed `load` refetches from the top. */
  load: (before: string | null) => Promise<FeedPage>;
  emptyMessage: string;
  /** The signed-in viewer's handle, or `null` when signed out. Decides which rows get a menu. */
  ownHandle: string | null;
  onEdit?: (post: PostView) => void;
  onDeleted?: (id: string) => void;
}

/**
 * A paginated list of posts with a "Muat lebih banyak" button, driving
 * `PostCard` for each row. Both Beranda (Task 5) and a profile's posts tab
 * (Task 6) render this with their own `load` function — the fetch shape
 * (`listFeed`/`listUserPosts`, which tab, which handle) is entirely the
 * caller's decision; this component only knows "give me a page for this
 * cursor".
 *
 * The state is FOUR separate pieces — `posts`, `nextCursor`, `loading`,
 * `error` — never one discriminated union. A union forces an error to
 * replace the list, which is the exact regression the final review of
 * Phase 2 made a merge blocker: a failed "load more" must leave whatever
 * already loaded on screen, with the error shown alongside it, not instead
 * of it.
 */
export default function PostFeed({ load, emptyMessage, ownHandle, onEdit, onDeleted }: Props) {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Held SEPARATELY from `posts`. A failed "load more" must leave what already
  // loaded on screen — the final review of Phase 2 measured the alternative.
  const [error, setError] = useState<string | null>(null);
  const [firstPageLoaded, setFirstPageLoaded] = useState(false);

  const fetchPage = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await load(before);
        setPosts((current) => (before === null ? page.posts : [...current, ...page.posts]));
        setNextCursor(page.nextCursor);
        setFirstPageLoaded(true);
      } catch (err: unknown) {
        setError(describeRequestFailure(err));
      } finally {
        setLoading(false);
      }
    },
    [load]
  );

  useEffect(() => {
    setPosts([]);
    setNextCursor(null);
    setFirstPageLoaded(false);
    void fetchPage(null);
  }, [fetchPage]);

  return (
    <div className="post-feed">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          isOwn={ownHandle !== null && post.author.handle === ownHandle}
          onEdit={onEdit}
          onDeleted={onDeleted}
        />
      ))}

      {firstPageLoaded && posts.length === 0 && !loading ? (
        <p className="empty">{emptyMessage}</p>
      ) : null}

      {/* `role="alert"` matches every other top-level request-failure element
          under src/user (FollowButton, LoginPage, SignupPage, ...) — a screen
          reader must announce this the same way it announces theirs. */}
      {error !== null ? (
        <p className="feed-error" role="alert">
          {error}
        </p>
      ) : null}

      {nextCursor !== null ? (
        <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
          {loading ? "Memuat..." : "Muat lebih banyak"}
        </button>
      ) : null}
    </div>
  );
}
