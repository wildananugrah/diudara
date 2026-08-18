import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import PostComposer from "./PostComposer";
import { DeleteConfirm, EditComposer, usePostOwnerActions } from "./postOwnerActions";
import {
  createPost,
  getSessionUser,
  isUserSignedIn,
  listFeed,
  subscribeToUserAuth,
} from "./apiClient";

type Tab = "untuk-anda" | "mengikuti";

/**
 * `/beranda` — the two-tab member feed (design spec §2), plus composing,
 * editing and deleting your own posts.
 *
 * **The tab lives in the URL, not in component state.** `?tab=mengikuti` means
 * Mengikuti and anything else — including no query string at all — means Untuk
 * Anda, so the bare `/beranda` is the default rather than a redirect. Back and
 * forward then work, and a link to Mengikuti is shareable. `BerandaPage.test.tsx`
 * pins this against the URL itself rather than against what renders, because
 * component state can make the right tab render while breaking both of those.
 *
 * **Signed out, Mengikuti fires no request at all.** That tab needs a viewer the
 * server can resolve; `listFeed("mengikuti")` goes through `apiFetch`, which
 * clears the session and throws `SESSION_EXPIRED_MESSAGE` on the 401 it can only
 * ever get. So a signed-out visitor gets a link to `/masuk` instead — the same
 * choice the profile's follow button makes with "Masuk untuk mengikuti", and the
 * reason nobody ever sees "Sesi Anda sudah berakhir" on a page they were never
 * signed in to. **Untuk Anda still loads signed out**, through `publicGet`, since
 * `/beranda` is a publicly reachable route; that split is the whole reason the
 * endpoint has two auth paths.
 *
 * **The post list belongs to `PostFeed`, reached through `PostFeedHandle`.** The
 * brief offered a second `prepended` list held here instead; see
 * `PostFeedHandle`'s own docstring for why that shape cannot express a delete or
 * an in-place edit at all, and duplicates a new post across a tab switch.
 */
export default function BerandaPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "mengikuti" ? "mengikuti" : "untuk-anda";
  /**
   * SUBSCRIBED, not read once per render (fix round 1). `apiFetch` clears the
   * session on any 401, so a token that expires while somebody is reading
   * Mengikuti makes this false — and the review measured what a plain
   * `isUserSignedIn()` call left behind: the composer and its live "Kirim"
   * button still on screen beside a session that no longer exists, with the
   * next submit guaranteed to 401 too. `AppShell` already answers this question
   * exactly this way, and `isUserSignedIn` returns a boolean precisely so it is
   * a stable snapshot.
   */
  const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);
  const ownHandle = getSessionUser()?.handle ?? null;

  const feed = useRef<PostFeedHandle>(null);
  /**
   * Edit and delete, shared verbatim with `ProfilePage` — see
   * `usePostOwnerActions`, which also owns the per-tab reset of all four
   * pieces of its state. Keyed on `tab` here: a tab change replaces the whole
   * list, so nothing about a row in the old one may survive it.
   */
  const {
    editing,
    pendingDelete,
    deleting,
    deleteError,
    onEdit,
    onDeleteRequested,
    confirmDelete,
    cancelDelete,
    cancelEdit,
    saveEdit,
  } = usePostOwnerActions(feed, tab);
  /** Set by a successful create made from Mengikuti, which cannot show it. Cleared by the tab-change effect below — see there for why this is not derived from `tab`. */
  const [postSent, setPostSent] = useState(false);

  // Memoised on `tab` so PostFeed refetches when the tab changes and NOT on
  // every render. See PostFeed's own note: without this the effect loops, which
  // is a hang rather than a slowdown.
  const load = useCallback((before: string | null) => listFeed(tab, before), [tab]);

  /**
   * **Everything transient is about a row in the list the CURRENT tab is
   * showing, and a tab change replaces that list wholesale.** So all of it is
   * dropped here (fix round 1). The edit/delete half of it lives in
   * `usePostOwnerActions`, keyed on the same `tab`; this notice is Beranda's
   * alone, so it is reset here.
   *
   * This used to be a `sentFrom: Tab | null` compared against `tab` during
   * render, which HID the notice on the other tab without ever CLEARING it —
   * so posting from Mengikuti, visiting Untuk Anda and coming back put
   * "Kiriman Anda terkirim" on screen again, announcing a post that was sent
   * minutes ago. The confirmation panel and the edit composer had the same
   * shape of bug and were worse: "Hapus kiriman ini?" survived a tab switch
   * with zero rows rendered behind it, and "Ya, hapus" still fired the DELETE
   * for a post that was no longer on screen.
   *
   * An effect rather than the two tab buttons' `onClick`, because the tab also
   * changes on back/forward and on a shared link, which never go through those
   * handlers. It runs on mount too, where every setter is already at its
   * initial value — React bails out of an equal `useState` write, so that costs
   * no extra render.
   */
  useEffect(() => {
    setPostSent(false);
  }, [tab]);

  async function handleCreate(body: string, mediaIds: string[]): Promise<void> {
    // The composer sends the complete list of ids it managed to upload — see
    // `PostComposer`'s `onSubmit`. Passed straight through: `position` is the
    // array's order (spec §5.2), so this page must not reorder or filter it.
    const created = await createPost(body, mediaIds);
    // `mengikuti` is "posts by people you follow, never your own" — measured in
    // `drizzle-post.repository.test.ts`'s "returns only followed authors' posts,
    // never the viewer's own". Prepending your new post there would show a row
    // that the very next refetch silently removes, so that tab says what
    // happened instead of showing something untrue.
    if (tab === "mengikuti") {
      setPostSent(true);
      return;
    }
    // No `setPostSent(false)` here: `postSent` can only ever have been set from
    // Mengikuti, and the tab-change effect above clears it on the way to this
    // tab. It was removable with the whole suite green, which made it a third
    // state nothing owned rather than a safety net.
    feed.current?.prepend(created);
  }

  return (
    <main className="user-page beranda-page">
      <h1>Beranda</h1>

      <nav className="feed-tabs" aria-label="Jenis beranda">
        <button type="button" aria-current={tab === "untuk-anda"} onClick={() => setParams({})}>
          Untuk Anda
        </button>
        <button
          type="button"
          aria-current={tab === "mengikuti"}
          onClick={() => setParams({ tab: "mengikuti" })}
        >
          Mengikuti
        </button>
      </nav>

      {signedIn ? (
        // Keyed, so switching between composing and editing — and between two
        // different posts — resets the box rather than carrying the previous
        // text over. `initialBody` alone would not: it only seeds `useState`.
        // The edit half of that keying lives in `EditComposer`.
        editing !== null ? (
          <EditComposer post={editing} onSubmit={saveEdit} onCancel={cancelEdit} />
        ) : (
          <PostComposer key="baru" submitLabel="Kirim" onSubmit={handleCreate} />
        )
      ) : null}

      {postSent ? (
        <p className="feed-notice" role="status">
          Kiriman Anda terkirim. Buka tab Untuk Anda untuk melihatnya.
        </p>
      ) : null}

      {pendingDelete !== null ? (
        <DeleteConfirm
          postId={pendingDelete}
          deleting={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      ) : null}

      {deleteError !== null ? (
        <p className="feed-error" role="alert">
          {deleteError}
        </p>
      ) : null}

      {tab === "mengikuti" && !signedIn ? (
        <p className="signed-out-notice">
          <Link to="/masuk">Masuk untuk melihat</Link>
        </p>
      ) : (
        <PostFeed
          ref={feed}
          load={load}
          ownHandle={ownHandle}
          onEdit={onEdit}
          onDeleteRequested={onDeleteRequested}
          emptyMessage={
            tab === "mengikuti"
              ? "Belum ada kiriman dari orang yang Anda ikuti."
              : "Belum ada kiriman untuk ditampilkan."
          }
        />
      )}

      <p>
        Temukan orang untuk diikuti di <Link to="/jelajah">Jelajah</Link>.
      </p>
    </main>
  );
}
