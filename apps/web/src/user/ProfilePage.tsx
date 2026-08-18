import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import {
  deletePost,
  editPost,
  getProfileByHandle,
  getSessionUser,
  listUserPosts,
  UserApiError,
  type PostView,
  type PublicUserProfile,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import FollowButton from "./FollowButton";
import PostComposer from "./PostComposer";
import PostFeed, { type PostFeedHandle } from "./PostFeed";

const DELETE_FAILED_PREFIX = "Gagal menghapus kiriman.";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: PublicUserProfile };

/**
 * `GET /@:handle` — well, not literally: React Router cannot mix a literal
 * `@` and a param inside one path segment (`path="/@:handle"` does NOT
 * match `/@wildan` — see App.tsx's own comment on this route). So this
 * mounts at the bare `path="/:handleParam"`, registered LAST, right before
 * the catch-all, so a static route like `/signup` or `/masuk` always wins
 * over this one. What arrives here is the WHOLE first path segment,
 * including the `@` if the visitor typed one — and it is this component's
 * own job to tell "a profile URL" from "junk", by checking that leading
 * `@` itself and 404ing (the SAME 404 page every other unknown URL gets,
 * with no hint the handle is actually free) when it is absent.
 */
export default function ProfilePage() {
  const { handleParam } = useParams<{ handleParam: string }>();
  const isProfileUrl = typeof handleParam === "string" && handleParam.startsWith("@");
  const handle = isProfileUrl ? handleParam.slice(1) : "";
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // Mirrors `profile.followerCount`/`profile.viewerFollows` once loaded, kept
  // as separate state (not read straight off `load`) so `FollowButton`'s
  // `onChange` can update the visible count without a refetch — see
  // `handleFollowChange` below. Declared unconditionally, alongside `load`
  // itself, since hooks cannot follow the early `status !== "ready"` returns
  // further down.
  const [followerCount, setFollowerCount] = useState(0);
  const [viewerFollowing, setViewerFollowing] = useState<boolean | null>(null);

  /**
   * The signed-in viewer's own handle, or `null` when signed out — the same
   * read `BerandaPage` does, not subscribed via `useSyncExternalStore`
   * because nothing here needs to react to a mid-visit sign-out the way the
   * composer's live "Kirim" button does.
   *
   * Handed to `PostFeed` as `ownHandle`; `PostFeed` is the one that compares
   * it against each row's `post.author.handle` to decide `isOwn` (see
   * `PostCard`'s docstring — that comparison happens once, in one place, so
   * a profile page and Beranda can never compute "is this mine" two
   * different ways). Every post `listUserPosts(handle, ...)` returns is
   * authored by THIS profile's handle, so "isOwn" here really does mean
   * "am I looking at my own profile" — never assumed as a boolean prop.
   */
  const ownHandle = getSessionUser()?.handle ?? null;

  const postsFeed = useRef<PostFeedHandle>(null);
  /** The id awaiting delete confirmation. `null` means nothing is pending — no separate "confirming" flag to drift out of step with it. Mirrors BerandaPage's own shape (Task 5). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** The post being edited, or `null` when nothing is. Never a boolean plus an id — the composer needs the body to pre-fill. Mirrors `BerandaPage`'s own shape (fix round 1, item 2). */
  const [editing, setEditing] = useState<PostView | null>(null);

  /**
   * `PostFeed` fetches through this, entirely on its own — see `PostFeed`'s
   * own `useEffect`. **Held completely apart from `load`/`setLoad` above on
   * purpose**: a failed post fetch must not blank a profile header that
   * already rendered successfully, the same rule Jelajah's rails follow and
   * the rule Phase 2's final review made a merge blocker. `PostFeed` owns
   * its own loading/error state for exactly this reason, so there is
   * nothing here to wire the two together even by accident — no `.then`,
   * no `.catch`, this function only forwards the cursor.
   *
   * Memoised on `handle` so `PostFeed` does not refetch on every render —
   * an unmemoised `load` is a hang, not a slowdown (see `PostFeed.tsx`).
   */
  const loadPosts = useCallback((before: string | null) => listUserPosts(handle, before), [handle]);

  /**
   * `ProfilePage` is ONE route element (`/:handleParam`, App.tsx) — a link
   * from `/@wildan` to `/@budi` keeps this same component instance, only
   * `handle` changes. Everything below is about a post on the profile the
   * viewer was JUST looking at, so it is dropped here rather than carried
   * onto a different person's posts. Fix round 1, item 1: measured by the
   * reviewer, a delete confirmation opened on one profile survived onto the
   * next and fired a DELETE for a post that was no longer even on screen.
   * Mirrors `BerandaPage`'s own reset effect, keyed on `tab` there and on
   * `handle` here for the same reason.
   */
  useEffect(() => {
    setPendingDelete(null);
    setDeleteError(null);
    setEditing(null);
  }, [handle]);

  async function handleSaveEdit(body: string): Promise<void> {
    const target = editing;
    if (target === null) return;
    // Deliberately NOT wrapped in try/catch — same reasoning as
    // `BerandaPage.handleSaveEdit`: a rejection has to reach `PostComposer`,
    // which is what keeps the author's text and shows the error. Swallowing
    // it here would clear the box on a failed save.
    const updated = await editPost(target.id, body);
    postsFeed.current?.replace(updated);
    setEditing(null);
  }

  async function confirmDelete(): Promise<void> {
    const id = pendingDelete;
    if (id === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePost(id);
      postsFeed.current?.remove(id);
      setPendingDelete(null);
      // Editing the post you just deleted would leave a composer saving into
      // a 404 — same guard as `BerandaPage.confirmDelete`.
      if (editing?.id === id) setEditing(null);
    } catch (err: unknown) {
      setDeleteError(`${DELETE_FAILED_PREFIX} ${describeRequestFailure(err)}`);
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!isProfileUrl) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    getProfileByHandle(handle)
      .then((profile) => {
        if (cancelled) return;
        setLoad({ status: "ready", profile });
        setFollowerCount(profile.followerCount);
        setViewerFollowing(profile.viewerFollows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UserApiError && err.status === 404) {
          setLoad({ status: "not-found" });
        } else {
          // N1: NEVER `err.message`. That is the server's own string — English
          // for a 404 ("user not found"), and the browser's own "Failed to
          // fetch" for a network drop, both measured on this component. The
          // heading below supplies the Bahasa context; this supplies the
          // Bahasa reason. See `errorCopy.ts`.
          setLoad({ status: "error", message: describeRequestFailure(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isProfileUrl, handle]);

  /**
   * `FollowButton`'s `onChange` — told the RESULTING state after a
   * successful toggle. The follower count belongs to the PROFILE being
   * viewed, not the viewer, so a follow increments it and an unfollow
   * decrements it; the delta is computed against the previously known
   * `viewerFollowing` rather than assumed, so a toggle that (somehow)
   * resolves to the same state it started at is a no-op on the count too.
   */
  function handleFollowChange(following: boolean) {
    setFollowerCount((count) => count + (following ? 1 : 0) - (viewerFollowing === true ? 1 : 0));
    setViewerFollowing(following);
  }

  // Not a `/@...` URL at all — the same 404 as any other unmatched path,
  // never a hint that a bare-word path is free to register as a handle.
  if (!isProfileUrl) {
    return <NotFoundPage />;
  }

  if (load.status === "not-found") {
    return <NotFoundPage />;
  }

  if (load.status === "loading") {
    return (
      <main className="user-page">
        <p>Memuat...</p>
      </main>
    );
  }

  if (load.status === "error") {
    return (
      <main className="user-page">
        <h1>Gagal memuat profil</h1>
        <p>{load.message}</p>
      </main>
    );
  }

  const { profile } = load;
  return (
    <main className="user-page profile-page">
      <div className="spread">
        <div>
          <h1 className="profile-name">{profile.displayName}</h1>
          <p className="profile-handle muted">@{profile.handle}</p>
        </div>
        {/*
          Absent entirely on your own profile — FollowButton itself decides
          that by comparing `profile.handle` to the signed-in caller's own
          handle (see its own docstring), never by trusting
          `viewerFollowing`/`viewerFollows` alone: the API deliberately
          reports `false`, not some self-specific value, when the viewer IS
          the profile.
        */}
        <FollowButton handle={profile.handle} viewerFollows={viewerFollowing} onChange={handleFollowChange} />
      </div>
      {/* No element at all for a bio-less profile — never an empty <p>. */}
      {profile.bio !== null && profile.bio !== "" ? <p className="profile-bio">{profile.bio}</p> : null}
      <div className="profile-counts">
        <Link to={`/@${profile.handle}/pengikut`} className="profile-count">
          <strong>{followerCount}</strong> Pengikut
        </Link>
        <Link to={`/@${profile.handle}/mengikuti`} className="profile-count">
          <strong>{profile.followingCount}</strong> Mengikuti
        </Link>
      </div>

      {/*
        Keyed on `editing.id`, exactly like `BerandaPage`'s edit composer —
        Beranda's own fix round 1 found that without the key, editing post A
        then post B silently saves A's text over B, because `initialBody`
        alone only seeds `useState` and does not reset it on a later render.
      */}
      {editing !== null ? (
        <PostComposer
          key={editing.id}
          initialBody={editing.body}
          submitLabel="Simpan"
          onSubmit={handleSaveEdit}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {pendingDelete !== null ? (
        <div className="delete-confirm" role="group" aria-label="Konfirmasi hapus">
          <p>Hapus kiriman ini?</p>
          {/* "Tidak jadi" — not "Batal" — for the same reason as Beranda's own
              confirmation panel: two buttons sharing one accessible name is
              an ambiguity a screen reader and `getByRole` both have to
              resolve by position. */}
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

      {/*
        `PostFeed` owns its own loading and error state entirely — a failed
        fetch here shows its own `role="alert"` paragraph next to the header
        above, which stays exactly as it was. Nothing in this component's
        `load`/`setLoad` is touched by anything that happens inside
        `PostFeed`.
      */}
      <PostFeed
        ref={postsFeed}
        load={loadPosts}
        ownHandle={ownHandle}
        onEdit={(post) => {
          // Opening Edit for one post must close a delete confirmation for
          // another (or the same) post — otherwise both panels can render at
          // once. A parked finding from Task 5: this exact bug existed on
          // `BerandaPage` and is fixed there too in this same round.
          setDeleteError(null);
          setPendingDelete(null);
          setEditing(post);
        }}
        onDeleteRequested={(id) => {
          // Symmetric with `onEdit` above — requesting a delete must close an
          // open edit composer.
          setDeleteError(null);
          setEditing(null);
          setPendingDelete(id);
        }}
        emptyMessage="Belum ada kiriman untuk ditampilkan."
      />
    </main>
  );
}
