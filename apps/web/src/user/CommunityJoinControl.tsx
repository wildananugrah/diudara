import { useState } from "react";
import { Link } from "react-router-dom";
import { joinCommunity, leaveCommunity, type CommunityDetail } from "./apiClient";
import { describeCommunityFailure } from "./errorCopy";
import { billingCycleLabel, formatTierPrice } from "./tierCopy";

/**
 * **The join control, in its three mutually exclusive shapes** — Phase 1's
 * `CommunityPage` banner control, lifted into its own module in Phase 2. It
 * still renders in the banner and NOWHERE ELSE (ruling R12): `CommunityFeed`
 * shows only a non-interactive note pointing here, so a non-member can join
 * from either tab and there is never a second button to keep in step.
 *
 * Its props are primitives — `slug`, `viewerIsMember`, `viewerIsOwner` — rather
 * than a whole `CommunityDetail`, so the extraction did not drag the detail
 * type along.
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
 *
 * **`price` only changes the label, never the action.** `null` (no active
 * tier at all — the vast majority of communities today) keeps the exact plain
 * "Gabung" this control has always shown; only a community that has actually
 * priced itself gets the annotation, "Gabung — Gratis" for a tier priced at
 * zero and "Gabung — {price} {cycle}" otherwise — the same `tierCopy.ts`
 * helpers `CommunityCard` uses for the same numbers.
 */
export default function CommunityJoinControl({
  slug,
  viewerIsMember,
  viewerIsOwner,
  price,
  onChanged,
}: {
  slug: string;
  viewerIsMember: boolean | null;
  viewerIsOwner: boolean;
  price?: CommunityDetail["price"];
  onChanged: (member: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label =
    price === undefined || price === null
      ? "Gabung"
      : price.amount === 0
        ? "Gabung — Gratis"
        : `Gabung — ${formatTierPrice(price.amount)} ${billingCycleLabel(price.billingCycle)}`;

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
        {member ? "Keluar" : label}
      </button>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
