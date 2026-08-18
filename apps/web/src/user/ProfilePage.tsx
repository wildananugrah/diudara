import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import {
  getProfileByHandle,
  getSessionUser,
  listUserPosts,
  UserApiError,
  type PublicUserProfile,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import FollowButton from "./FollowButton";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import { DeleteConfirm, EditComposer, usePostOwnerActions } from "./postOwnerActions";

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
  /**
   * Edit and delete, shared verbatim with `BerandaPage` — see
   * `usePostOwnerActions`, which also owns the reset of all four pieces of its
   * state.
   *
   * Keyed on `handle`: `ProfilePage` is ONE route element (`/:handleParam`,
   * App.tsx), so a link from `/@wildan` to `/@budi` keeps this same component
   * instance and only `handle` changes. Everything the hook holds is about a
   * post on the profile the viewer was JUST looking at. Fix round 1, item 1:
   * measured by the reviewer, a delete confirmation opened on one profile
   * survived onto the next and fired a DELETE for a post that was no longer
   * even on screen. Sharing the hook with Beranda is what stops the two pages
   * drifting again — Task 6 originally copied this page's panel WITHOUT its
   * reset, which is how that defect arrived.
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
  } = usePostOwnerActions(postsFeed, handle);

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

      {/* The same `EditComposer` Beranda renders — keyed on `editing.id`
          inside it, for the reason its own docstring records. */}
      {editing !== null ? (
        <EditComposer post={editing} onSubmit={saveEdit} onCancel={cancelEdit} />
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
        onEdit={onEdit}
        onDeleteRequested={onDeleteRequested}
        emptyMessage="Belum ada kiriman untuk ditampilkan."
      />
    </main>
  );
}
