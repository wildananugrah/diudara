import { useState } from "react";
import { Link } from "react-router-dom";
import { joinCommunity, leaveCommunity } from "./apiClient";
import { describeCommunityFailure } from "./errorCopy";

/**
 * **The join control, in its three mutually exclusive shapes** — Phase 1's
 * `CommunityPage` banner control, lifted out of that file so Phase 2's
 * `CommunityFeed` renders the SAME one in the composer's place rather than a
 * second button (spec §"The web app": a non-member "sees the composer's place
 * taken by the same `Gabung` / `Masuk untuk gabung` control").
 *
 * Its props are the three primitives both callers already hold — `slug`,
 * `viewerIsMember`, `viewerIsOwner` — not a whole `CommunityDetail`, because
 * `CommunityFeed` is handed exactly those three and nothing more.
 *
 * **The owner gets NOTHING — not a disabled button.** `DELETE
 * /communities/:slug/join` answers 409 for an owner every time, and this
 * project's rule is that a control is never rendered for an action that would
 * fail.
 *
 * A signed-out visitor (`viewerIsMember === null`) gets a LINK to `/masuk`, not
 * a button: tapping it cannot join anything, so it should navigate rather than
 * fail. That is the whole reason `viewerIsMember` is `null` rather than `false`
 * for them — `false` means "signed in, not a member", the one case that gets a
 * working *Gabung*.
 */
export default function CommunityJoinControl({
  slug,
  viewerIsMember,
  viewerIsOwner,
  onChanged,
}: {
  slug: string;
  viewerIsMember: boolean | null;
  viewerIsOwner: boolean;
  onChanged: (member: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (viewerIsOwner) return null;
  if (viewerIsMember === null) {
    return (
      <Link className="button-primary btn btn-sm" to="/masuk">
        Masuk untuk gabung
      </Link>
    );
  }

  const member = viewerIsMember;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const result = member ? await leaveCommunity(slug) : await joinCommunity(slug);
      onChanged(result.member);
    } catch (err) {
      setError(describeCommunityFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={member ? "button-secondary btn btn-sm" : "button-primary btn btn-sm"}
        onClick={toggle}
        disabled={busy}
      >
        {member ? "Keluar" : "Gabung"}
      </button>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
