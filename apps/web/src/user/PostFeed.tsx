import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
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
  onDeleteRequested?: (id: string) => void;
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
export default function PostFeed({ load, emptyMessage, ownHandle, onEdit, onDeleteRequested, ref }: Props) {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Held SEPARATELY from `posts`. A failed "load more" must leave what already
  // loaded on screen — the final review of Phase 2 measured the alternative.
  const [error, setError] = useState<string | null>(null);
  const [firstPageLoaded, setFirstPageLoaded] = useState(false);

  /**
   * **The token every in-flight request checks before it writes anything.**
   *
   * Whole-branch review C1. `fetchPage` had no cancellation and the effect
   * below had no cleanup, so when `load` changed identity — a Beranda tab
   * switch, a link from one profile to another — the PREVIOUS request's
   * `setPosts`/`setNextCursor`/`setError`/`setLoading` all still landed. And a
   * first page is fetched with `before === null`, whose setter REPLACES rather
   * than appends, so the old feed overwrote the new one: measured on the real
   * `BerandaPage`, tapping Mengikuti while Untuk Anda was still loading left
   * Mengikuti selected and showing the viewer's OWN post — a row excluded from
   * that tab by the `follow_no_self` CHECK constraint and therefore impossible
   * there. Two more effects from the same path: the stale `nextCursor` made
   * "Muat lebih banyak" page the OLD feed, and a stale load-more response
   * appended old rows to the new list.
   *
   * A ref rather than a plain effect-scoped `let`, because "load more" is
   * fired from a CLICK, outside the effect, and it needs the same token. The
   * effect replaces this on every run and its cleanup marks the outgoing one
   * cancelled; `ProfilePage`'s own profile fetch uses the same idiom.
   */
  const run = useRef<{ cancelled: boolean }>({ cancelled: false });

  /**
   * Rows added through `prepend` since the current `load` began.
   *
   * The parked "create racing the first page load" finding: `handleCreate`
   * prepends a just-created post, and if the first page had not arrived yet,
   * its `before === null` write REPLACED the list and the author watched their
   * own post vanish. These rows are re-applied on top of the first page that
   * arrives, then cleared. `replace`/`remove` maintain this list too, so a post
   * edited or deleted during that same window cannot come back from the dead.
   */
  const pending = useRef<PostView[]>([]);

  /** Applies one update to the visible list AND to the pending-prepend list, so the two can never disagree. */
  const apply = useCallback((update: (rows: PostView[]) => PostView[]) => {
    pending.current = update(pending.current);
    setPosts(update);
  }, []);

  const fetchPage = useCallback(
    async (before: string | null, isStale: () => boolean) => {
      setLoading(true);
      // Cleared on the way IN, not only on success: a stale error banner from a
      // failed load must not survive into the next tab or the next profile.
      setError(null);
      try {
        const page = await load(before);
        if (isStale()) return;
        if (before === null) {
          setPosts([...pending.current, ...page.posts]);
          pending.current = [];
        } else {
          setPosts((current) => [...current, ...page.posts]);
        }
        setNextCursor(page.nextCursor);
        setFirstPageLoaded(true);
      } catch (err: unknown) {
        if (isStale()) return;
        setError(describeRequestFailure(err));
      } finally {
        // A stale request must not turn the spinner off under the request that
        // replaced it, either.
        if (!isStale()) setLoading(false);
      }
    },
    [load]
  );

  useEffect(() => {
    const token = { cancelled: false };
    run.current = token;
    pending.current = [];
    setPosts([]);
    setNextCursor(null);
    setFirstPageLoaded(false);
    void fetchPage(null, () => token.cancelled);
    return () => {
      token.cancelled = true;
    };
  }, [fetchPage]);

  // Deps are `[apply]`, which is itself stable (empty deps): all three are pure
  // list updaters closing over nothing that changes, so the handle's identity
  // is stable for the feed's lifetime.
  useImperativeHandle(
    ref,
    () => ({
      prepend: (post: PostView) => apply((current) => [post, ...current]),
      replace: (post: PostView) =>
        apply((current) => current.map((row) => (row.id === post.id ? post : row))),
      remove: (id: string) => apply((current) => current.filter((row) => row.id !== id)),
    }),
    [apply]
  );

  return (
    <div className="post-feed">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          isOwn={ownHandle !== null && post.author.handle === ownHandle}
          onEdit={onEdit}
          onDeleteRequested={onDeleteRequested}
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
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            // Captured at click time: the page this click belongs to. If `load`
            // changes while this request is out, the response is discarded
            // rather than appended to somebody else's feed.
            const token = run.current;
            void fetchPage(nextCursor, () => token.cancelled);
          }}
        >
          {loading ? "Memuat..." : "Muat lebih banyak"}
        </button>
      ) : null}
    </div>
  );
}
