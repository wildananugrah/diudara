import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import {
  getProfileByHandle,
  getSessionUser,
  listStreams,
  listUserPosts,
  UserApiError,
  type PublicUserProfile,
  type StreamView,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import FollowButton from "./FollowButton";
import MembershipOffer from "./MembershipOffer";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import StreamPlayer from "./StreamPlayer";
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

  /**
   * This person's live broadcast, if they have one right now.
   *
   * READ OFF `GET /streams`, the same public listing Siaran renders — NOT a
   * new field on the profile response. Whether a stream is `locked` is the
   * membership paywall's answer, and that answer already has exactly one
   * implementation, reviewed and mutation-tested. Adding a second place that
   * decides it is the drift this codebase keeps getting caught by: a
   * whole-branch review found two membership predicates that had silently
   * disagreed, and the spec names that failure explicitly.
   *
   * The cost is honest and small: the profile fetches every live row to find
   * at most one. If that ever matters, a targeted endpoint is the fix — and
   * by then `locked` will have a second reviewed home to live in.
   *
   * Failures are SILENT. A profile that loaded is not broken because the live
   * index was unreachable; the badge simply does not appear.
   */
  const [liveStream, setLiveStream] = useState<StreamView | null>(null);

  useEffect(() => {
    if (handle === "") return;
    let cancelled = false;
    (async () => {
      try {
        const result = await listStreams();
        if (cancelled) return;
        const mine = result.streams.find(
          (stream) => stream.owner.handle.toLowerCase() === handle.toLowerCase()
        );
        setLiveStream(mine ?? null);
      } catch {
        // Silent by design — see the state's own docstring.
        if (!cancelled) setLiveStream(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handle]);
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
  const liveSectionId = "profile-live";
  return (
    <main className="user-page profile-page">
      <div className="spread">
        <div>
          <h1 className="profile-name">{profile.displayName}</h1>
          <p className="profile-handle muted">@{profile.handle}</p>
          {/*
            Only rendered when there is something to click. A badge that
            announces a broadcast and goes nowhere is the same defect as the
            lock CTA that linked to the page you were already standing on.
          */}
          {liveStream !== null ? (
            <a href={`#${liveSectionId}`} className="profile-live-badge" data-testid="profile-live-badge">
              SEDANG LIVE
            </a>
          ) : null}
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
        The broadcast itself, on the profile — so "SEDANG LIVE" has somewhere
        to go. Same `StreamPlayer` Siaran uses (its `attachHls`/`mintToken`
        props default to the real ones; Siaran only injects them for tests),
        and the SAME lock treatment: `locked` is the server's answer, computed
        once by the paywall, so a members-only broadcast stays members-only for
        a stranger standing on a public profile.
      */}
      {liveStream !== null ? (
        <section id={liveSectionId} className="profile-live" data-testid="profile-live">
          <h2 className="profile-live-title">{liveStream.title}</h2>
          {liveStream.locked ? (
            <div className="stream-lock" data-testid="profile-live-lock">
              <p className="stream-lock-copy">Siaran ini khusus anggota.</p>
              <span className="stream-lock-cta">Jadi anggota untuk menonton</span>
            </div>
          ) : (
            <StreamPlayer stream={liveStream} />
          )}
        </section>
      ) : null}

      {/*
        Task 10, spec §6. Given the tiers off the profile response and nothing
        else — `MembershipOffer` decides for itself whether to render at all
        (no tiers, or your own profile) and whether to offer a button or a link
        to Masuk, exactly as `FollowButton` above decides its own own-profile
        case. Placed under the counts and above the feed: it is part of who
        this person is, not part of what they posted.

        `membership?.tiers ?? []` even though the field is REQUIRED on
        `PublicUserProfile` and the API always sends it (`toMembershipView`
        answers `{ tiers: [] }` rather than omitting the key). That is not a
        state branch — an absent field and an empty list mean the same thing
        here, "no offer" — it is the blast radius. A bare
        `profile.membership.tiers` THROWS on a response that predates Task 5,
        and it throws during render: measured against `App.test.tsx`'s own
        minimal profile fixtures, the whole page went blank — name, bio,
        follow button, counts and the entire feed — for a missing offer. A
        rolling deploy that ships this app before the API is exactly that
        response, and Phase 4 already shipped a version of this mistake
        (`toMembershipView`'s docstring records the white screen it caused).
      */}
      <MembershipOffer
        handle={profile.handle}
        tiers={profile.membership?.tiers ?? []}
        // `?? false` for the same skew reason as `tiers` above, and `false` is
        // the safe half of it: a response that could not tell us whether this
        // viewer is a member must never end up CLAIMING that they are.
        viewerIsMember={profile.membership?.viewerIsMember ?? false}
        // `?? false` again, and here the safe half is the OTHER direction:
        // an API that predates this field says nothing about a lapsed
        // membership, and defaulting to `true` would tell every signed-in
        // visitor on that deploy that a membership of theirs had ended.
        viewerMembershipEnded={profile.membership?.viewerMembershipEnded ?? false}
        // `?? false` again, same skew reasoning: an API response that
        // predates Task 6 says nothing about a pending free request, and
        // defaulting to `true` would withhold every tier's button from
        // everybody until the next deploy finished.
        viewerRequestPending={profile.membership?.viewerRequestPending ?? false}
      />

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
