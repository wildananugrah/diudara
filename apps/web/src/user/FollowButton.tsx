import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { followUser, getSessionUser, unfollowUser } from "./apiClient";

export interface FollowButtonProps {
  /** The TARGET profile's handle — already normalised (lowercase) by the server, same as every `PublicUserProfile.handle`/`FollowListRow.handle`. */
  handle: string;
  /**
   * `PublicUserProfile.viewerFollows` (or the caller's best guess of it —
   * see `FollowRow` in `JelajahPage.tsx` for the one place that guesses).
   * `null` (signed out) renders a link to `/masuk` instead of a button;
   * `true`/`false` render the toggle. NEVER collapse `null` to `false` — see
   * that field's own docstring in `apiClient.ts`.
   */
  viewerFollows: boolean | null;
  /** Told the RESULTING state after every successful toggle, so a caller showing a follower count (ProfilePage) can update it without a refetch. */
  onChange?: (following: boolean) => void;
}

/**
 * The follow/unfollow toggle — Task 5. **Renders nothing at all on your own
 * profile.**
 *
 * Carry-forward from Task 2's review: `viewerFollows` is `false` — not some
 * third, self-specific value — when the viewer IS the profile, because the
 * API deliberately emits no self-signal (`GetUserProfile.execute` calls
 * `follows.isFollowing(viewerId, user.id)`, which is simply `false` when
 * `viewerId === user.id`; nobody can follow themselves). A button driven off
 * `viewerFollows` alone would therefore render "Ikuti" on your own profile
 * and collect a 409 the moment it was tapped (`FollowUser`'s self-follow
 * guard). The only correct check is comparing handles — and it costs no
 * extra fetch, since the signed-in caller's own handle is already cached in
 * `localStorage` by `setUserSession` and read back via `getSessionUser()`.
 *
 * **Optimistic, not a spinner.** A tap flips the visible state immediately;
 * a failed request reverts it. Because `POST`/`DELETE .../follow` are both
 * idempotent (`FollowUser`'s own docstring), a double-tap before the first
 * request resolves is safe — but the button is `disabled` while one is in
 * flight anyway, so the displayed count on the profile above it never
 * visibly bounces between two in-flight taps.
 */
export default function FollowButton({ handle, viewerFollows, onChange }: FollowButtonProps) {
  const [following, setFollowing] = useState(viewerFollows === true);
  const [pending, setPending] = useState(false);

  // A different profile navigated to (or a fresh fetch resolved) — the
  // toggle's local state must follow the new prop, not keep the previous
  // profile's.
  useEffect(() => {
    setFollowing(viewerFollows === true);
  }, [viewerFollows, handle]);

  const session = getSessionUser();
  if (session !== null && session.handle.toLowerCase() === handle.toLowerCase()) {
    return null;
  }

  if (viewerFollows === null) {
    return (
      <Link className="button-secondary follow-button" to="/masuk">
        Masuk untuk mengikuti
      </Link>
    );
  }

  async function handleToggle() {
    const next = !following;
    setFollowing(next);
    setPending(true);
    try {
      const result = next ? await followUser(handle) : await unfollowUser(handle);
      setFollowing(result.following);
      onChange?.(result.following);
    } catch {
      setFollowing(!next);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={following ? "button-quiet follow-button" : "button-primary follow-button"}
      onClick={handleToggle}
      disabled={pending}
    >
      {following ? "Mengikuti" : "Ikuti"}
    </button>
  );
}
