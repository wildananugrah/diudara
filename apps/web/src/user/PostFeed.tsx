import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import PostCard from "./PostCard";
import { describeRequestFailure } from "./errorCopy";
import type { FeedPage, PostView } from "./apiClient";

/**
 * **The list this component loaded is THIS component's state, and these three
 * methods are the only way anybody else may change it.**
 *
 * Task 5's brief offered two ways to show a just-created post without a
 * refetch: keep a second `prepended` list in the PAGE and render it above the
 * feed, or lift the list in here behind a handle. The second is the one this
 * codebase can actually implement, because `posts` above is set ONLY by
 * `fetchPage` — a page holding its own parallel list can add rows above the
 * feed but has no way whatsoever to remove or rewrite a row the feed itself
 * loaded, and Beranda must do both (delete removes the row, edit updates it in
 * place). The parallel-list design also duplicates a new post the moment a tab
 * switch refetches it, which the page then has to remember to clear by hand.
 *
 * One list, one owner: `useEffect` below already resets `posts` whenever `load`
 * changes identity, so a refetch cannot leave a stale copy of anything behind.
 */
export interface PostFeedHandle {
  /** Puts a just-created post at the top, with no refetch. */
  prepend: (post: PostView) => void;
  /** Swaps a post for its edited version, IN PLACE — the row keeps its position. A post that is not on screen is left alone. */
  replace: (post: PostView) => void;
  /** Drops a deleted post's row. Idempotent, like the DELETE endpoint behind it. */
  remove: (id: string) => void;
}

interface Props {
  /** `null` means "the first page". Identity matters: a changed `load` refetches from the top. */
  load: (before: string | null) => Promise<FeedPage>;
  emptyMessage: string;
  /** The signed-in viewer's handle, or `null` when signed out. Decides which rows get a menu. */
  ownHandle: string | null;
  onEdit?: (post: PostView) => void;
  onDeleted?: (id: string) => void;
  /**
   * Optional access to `PostFeedHandle` above. Declared as a plain prop rather
   * than via `forwardRef`: React 19 (this project is on 19.2.8) passes `ref`
   * to function components as an ordinary prop, and `forwardRef` is deprecated.
   */
  ref?: Ref<PostFeedHandle>;
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
export default function PostFeed({ load, emptyMessage, ownHandle, onEdit, onDeleted, ref }: Props) {
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

  // Empty deps: all three are pure `setPosts` updaters and close over nothing
  // that changes, so the handle's identity is stable for the feed's lifetime.
  useImperativeHandle(
    ref,
    () => ({
      prepend: (post: PostView) => {
        setPosts((current) => [post, ...current]);
        // A prepend means at least one row exists, so the empty state must not
        // win a race with a first page that came back empty.
        setFirstPageLoaded(true);
      },
      replace: (post: PostView) =>
        setPosts((current) => current.map((row) => (row.id === post.id ? post : row))),
      remove: (id: string) => setPosts((current) => current.filter((row) => row.id !== id)),
    }),
    []
  );

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
