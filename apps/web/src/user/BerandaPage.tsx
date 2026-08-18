import { useCallback, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import PostComposer from "./PostComposer";
import {
  createPost,
  deletePost,
  editPost,
  getSessionUser,
  isUserSignedIn,
  listFeed,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import type { PostView } from "./apiClient";

type Tab = "untuk-anda" | "mengikuti";

const DELETE_FAILED_PREFIX = "Gagal menghapus kiriman.";

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
  const signedIn = isUserSignedIn();
  const ownHandle = getSessionUser()?.handle ?? null;

  const feed = useRef<PostFeedHandle>(null);
  /** The post being edited, or `null` when composing a new one. Never a boolean plus an id — the composer needs the body to pre-fill. */
  const [editing, setEditing] = useState<PostView | null>(null);
  /** The id awaiting confirmation. `null` means nothing is being deleted; there is no separate "confirming" flag to drift out of step with it. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * The tab a post was just created from, when that tab cannot show it. Stored
   * as the TAB rather than a boolean so switching tabs hides the notice for
   * free, with no effect and nothing to clear by hand.
   */
  const [sentFrom, setSentFrom] = useState<Tab | null>(null);

  // Memoised on `tab` so PostFeed refetches when the tab changes and NOT on
  // every render. See PostFeed's own note: without this the effect loops, which
  // is a hang rather than a slowdown.
  const load = useCallback((before: string | null) => listFeed(tab, before), [tab]);

  async function handleCreate(body: string): Promise<void> {
    const created = await createPost(body);
    // `mengikuti` is "posts by people you follow, never your own" — measured in
    // `drizzle-post.repository.test.ts`'s "returns only followed authors' posts,
    // never the viewer's own". Prepending your new post there would show a row
    // that the very next refetch silently removes, so that tab says what
    // happened instead of showing something untrue.
    if (tab === "mengikuti") {
      setSentFrom("mengikuti");
      return;
    }
    setSentFrom(null);
    feed.current?.prepend(created);
  }

  async function handleSaveEdit(body: string): Promise<void> {
    const target = editing;
    if (target === null) return;
    // Deliberately NOT wrapped in try/catch: a rejection has to reach
    // `PostComposer`, which is what keeps the author's text and shows the
    // error. Swallowing it here would clear the box on a failed save.
    const updated = await editPost(target.id, body);
    feed.current?.replace(updated);
    setEditing(null);
  }

  async function confirmDelete(): Promise<void> {
    const id = pendingDelete;
    if (id === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePost(id);
      feed.current?.remove(id);
      setPendingDelete(null);
      // Editing the post you just deleted would leave a composer saving into a
      // 404.
      if (editing?.id === id) setEditing(null);
    } catch (err: unknown) {
      setDeleteError(`${DELETE_FAILED_PREFIX} ${describeRequestFailure(err)}`);
    } finally {
      setDeleting(false);
    }
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
        editing !== null ? (
          <PostComposer
            key={editing.id}
            initialBody={editing.body}
            submitLabel="Simpan"
            onSubmit={handleSaveEdit}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <PostComposer key="baru" submitLabel="Kirim" onSubmit={handleCreate} />
        )
      ) : null}

      {sentFrom === tab ? (
        <p className="feed-notice" role="status">
          Kiriman Anda terkirim. Buka tab Untuk Anda untuk melihatnya.
        </p>
      ) : null}

      {pendingDelete !== null ? (
        <div className="delete-confirm" role="group" aria-label="Konfirmasi hapus">
          <p>Hapus kiriman ini?</p>
          {/* "Tidak jadi" rather than "Batal", which the edit composer above
              already uses — two buttons with one name is an ambiguity a user
              and a test both have to resolve by position. */}
          <button type="button" className="button-primary" disabled={deleting} onClick={() => void confirmDelete()}>
            Ya, hapus
          </button>
          <button type="button" className="button-quiet" disabled={deleting} onClick={() => setPendingDelete(null)}>
            Tidak jadi
          </button>
        </div>
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
          onEdit={(post) => {
            setDeleteError(null);
            setEditing(post);
          }}
          onDeleted={(id) => {
            // `PostCard` raises this on the TAP, not after a delete — nothing
            // has been removed yet. Confirmation happens here.
            setDeleteError(null);
            setPendingDelete(id);
          }}
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
