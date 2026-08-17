import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import { getProfileByHandle, UserApiError, type PublicUserProfile } from "./apiClient";
import FollowButton from "./FollowButton";

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
          setLoad({ status: "error", message: err instanceof Error ? err.message : "gagal memuat profil" });
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
    </main>
  );
}
