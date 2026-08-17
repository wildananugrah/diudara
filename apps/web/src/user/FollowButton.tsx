import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { followUser, getSessionUser, unfollowUser, UserApiError } from "./apiClient";

/**
 * What a failed follow/unfollow says — final review M2, which measured the old
 * `catch { setFollowing(!next); }` swallowing every failure: the button snapped
 * back and stayed a live toggle with no message, no redirect and no hint.
 *
 * This screen's OWN sentence, deliberately not the server's. The API's error
 * strings on this endpoint are not all Bahasa Indonesia (`routes/users.ts`
 * answers `{"error":"user not found"}` for an unknown handle) and `apiFetch`'s
 * own fallback embeds a bare HTTP status, so lifting the message verbatim —
 * the pattern that produced the English Zod sentence on Jelajah, item 5 —
 * would break the project-wide copy rule here too. Nothing actionable is lost:
 * the only failure with a specific remedy is the 401, and that one navigates
 * rather than explains.
 */
const FOLLOW_FAILED_MESSAGE = "Gagal memperbarui status mengikuti. Coba lagi.";

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
 * Both sides of the own-profile comparison below go through this — not just
 * the `handle` prop — so the check stays correct if either one ever carries
 * a leading `@` (defensive; today neither call site does: both
 * `PublicUserProfile.handle`/`FollowListRow.handle` and
 * `getSessionUser().handle` are already server-normalised) and so the two
 * sides cannot silently drift into an asymmetric comparison (review round
 * 2, Minor: applying `.toLowerCase()` to only one side survived every test
 * whose session and target handles already matched in case).
 */
function normalizeForComparison(raw: string): string {
  return raw.replace(/^@/, "").toLowerCase();
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
  const [error, setError] = useState<string | null>(null);
  // Declared up here with the rest, before the early returns below: hooks
  // cannot sit behind a conditional return.
  const navigate = useNavigate();

  // A different profile navigated to (or a fresh fetch resolved) — the
  // toggle's local state must follow the new prop, not keep the previous
  // profile's.
  useEffect(() => {
    setFollowing(viewerFollows === true);
  }, [viewerFollows, handle]);

  const session = getSessionUser();
  if (session !== null && normalizeForComparison(session.handle) === normalizeForComparison(handle)) {
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
    setError(null);
    setPending(true);
    try {
      const result = next ? await followUser(handle) : await unfollowUser(handle);
      setFollowing(result.following);
      onChange?.(result.following);
    } catch (err) {
      setFollowing(!next);
      // A 401 means `apiRequest` has ALREADY cleared the session on the way
      // past (see its own docstring), so this button is now a live toggle
      // attached to a session that no longer exists. An error message would be
      // the wrong response: there is a specific remedy, and it is signing in
      // again. Everything else gets the message — a 404 (the target was
      // deleted mid-tap), a 409 (a self-follow that slipped past the
      // own-profile hide), a 5xx, or a network failure with no status at all.
      if (err instanceof UserApiError && err.status === 401) {
        navigate("/masuk");
        return;
      }
      setError(FOLLOW_FAILED_MESSAGE);
    } finally {
      // Runs even on the `return` above. Harmless if that path navigated: this
      // component unmounts with the route, and React 19 no longer warns about
      // a state update on an unmounted component.
      setPending(false);
    }
  }

  return (
    <span className="follow-control">
      <button
        type="button"
        className={following ? "button-quiet follow-button" : "button-primary follow-button"}
        onClick={handleToggle}
        disabled={pending}
      >
        {following ? "Mengikuti" : "Ikuti"}
      </button>
      {error !== null ? (
        <span className="follow-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
