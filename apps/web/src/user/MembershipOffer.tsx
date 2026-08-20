import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatRupiah } from "../api";
import { isOwnHandle, startSubscription, UserApiError, isUserSignedIn, type TierView } from "./apiClient";
import { describeSubscribeFailure } from "./errorCopy";
import { billingCycleLabel } from "./tierCopy";

export interface MembershipOfferProps {
  /** The profile being viewed — the SELLER's handle, already server-normalised. */
  handle: string;
  /**
   * `PublicUserProfile.membership.tiers`, straight from
   * `GET /users/by-handle/:handle`. Already filtered to the ACTIVE tiers by
   * `listActiveByOwner`, so nothing here re-checks that; an empty array is a
   * creator who sells nothing, which is most profiles in this app.
   */
  tiers: TierView[];
}

/**
 * **The offer on a public profile, and the button that starts a purchase**
 * (spec §6: "A profile shows the offer and a 'Jadi anggota' button"). Task 10
 * of Phase 5a — the buyer's half of the first surface in this app where money
 * moves.
 *
 * THREE THINGS IT REFUSES TO RENDER, each for a reason the server enforces
 * independently:
 *
 *  - **Nothing at all when there are no tiers.** Not an empty box and not a
 *    heading standing over nothing. Most profiles here sell nothing, and
 *    `toMembershipView` reports `{ tiers: [] }` for a creator who has
 *    published none AND for one whose payout account is not connected — the
 *    two are indistinguishable from out here, and both mean there is no offer
 *    to make.
 *  - **Nothing at all on your own profile.** `StartUserSubscription` refuses
 *    it with a 409 and `user_subscription_no_self` forbids the row, so a
 *    button here could only ever collect a refusal. The check is
 *    `isOwnHandle` — a handle comparison, never `viewerFollows` or anything
 *    else in the payload, because the API deliberately emits no self-signal
 *    (see `isOwnHandle`'s own docstring, and `FollowButton`'s, which makes the
 *    identical decision through the identical function).
 *  - **No buy button for a signed-out visitor.** Buying is signed-in only
 *    (spec §6), so they get a link to Masuk that carries this profile as the
 *    place to return to — never a button that fires a request the server
 *    answers 401 to.
 *
 * WHAT IT DOES NOT SHOW, and the honest reason. **A visitor who is already an
 * active member still sees a buy button here.** Nothing on the wire says
 * otherwise: `GET /users/by-handle/:handle`'s `membership` is closed to
 * `{ tiers: [{ id, name, priceAmount, billingCycle }] }` (Task 5) and carries
 * no viewer-specific field, `IsMemberOf` (Task 8) is wired to no route in 5a,
 * and there is no endpoint that reports a viewer's own subscriptions. So this
 * component cannot know, and it does not pretend to: a member who presses is
 * refused by `StartUserSubscription`'s 409 — which never charges them — and
 * reads `describeSubscribeFailure`'s sentence, which names an existing
 * membership as one of the reasons rather than claiming to have identified
 * it. Making this state visible needs a server field, which is outside this
 * task's scope; see the Task 10 report.
 *
 * §9's limitation is deliberately NOT papered over either: 5a has no renewal
 * pass, so nothing here offers to renew a lapsed membership — there is no
 * endpoint behind such a button.
 *
 * Every failure becomes a Bahasa sentence through `errorCopy.ts`
 * (`src/test/no-raw-server-errors.test.ts`), except the 401 — the one failure
 * whose remedy is not a sentence but a destination, exactly as `FollowButton`
 * decided for the same status.
 */
export default function MembershipOffer({ handle, tiers }: MembershipOfferProps) {
  /** The tier whose purchase is in flight, or `null`. Also what disables every button. */
  const [pendingTierId, setPendingTierId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Declared before the early returns below, with the rest: hooks cannot sit
  // behind a conditional return.
  const navigate = useNavigate();

  /** Where Masuk sends a visitor back to once they are signed in — `LoginPage` reads this. */
  const backHere = `/@${handle}`;

  if (tiers.length === 0) return null;
  if (isOwnHandle(handle)) return null;

  const signedIn = isUserSignedIn();

  async function buy(tierId: string) {
    setError(null);
    setPendingTierId(tierId);
    try {
      const started = await startSubscription(handle, tierId);
      // Xendit's hosted invoice. A full-page navigation, not a router one:
      // this leaves the app entirely, and the provider brings the payer back
      // to this same profile afterwards (`StartUserSubscription.profileUrl`).
      window.location.href = started.invoiceUrl;
      // The button is deliberately left DISABLED here. The browser is on its
      // way to the provider, and re-enabling it during that gap invites a
      // second tap — which the server would answer with the same invoice
      // (`resolveExistingCheckout`), but only because it was built to survive
      // exactly this.
    } catch (err) {
      // Pressable again, whatever went wrong: the person has to be able to
      // try once the reason is gone.
      setPendingTierId(null);
      // A 401 means `apiRequest` has ALREADY cleared the session on its way
      // past (its own docstring), so this buyer is now signed out standing in
      // front of a signed-in-only action. There is a specific remedy and it is
      // not a sentence — the same call `FollowButton` makes for the same
      // status, to the same place.
      if (err instanceof UserApiError && err.status === 401) {
        navigate("/masuk", { state: { from: backHere } });
        return;
      }
      // N1: never `err.message`. The server's own 409 here is Bahasa, and it
      // is still not what a screen prints — see `errorCopy.ts`.
      setError(`Gagal memulai pembayaran keanggotaan. ${describeSubscribeFailure(err)}`);
    }
  }

  return (
    <section className="card stack membership-offer" aria-labelledby="membership-offer-heading">
      <h2 id="membership-offer-heading">Keanggotaan</h2>
      <p className="muted">Dukung @{handle} dengan menjadi anggota berbayar.</p>
      <ul className="membership-tiers">
        {tiers.map((tier) => (
          <li key={tier.id} className="membership-tier" data-testid={`membership-tier-${tier.id}`}>
            <div>
              <strong>{tier.name}</strong>
              <p className="muted">
                {formatRupiah(tier.priceAmount)} {billingCycleLabel(tier.billingCycle)}
              </p>
            </div>
            {signedIn ? (
              <button
                type="button"
                className="button-primary"
                // The tier's name is in the accessible name, not only beside
                // it: a profile may offer several tiers, and "Jadi anggota"
                // repeated three times tells a screen-reader user nothing
                // about which membership they are about to buy.
                aria-label={`${
                  pendingTierId === tier.id ? "Menyiapkan pembayaran" : "Jadi anggota"
                } — ${tier.name}`}
                disabled={pendingTierId !== null}
                onClick={() => void buy(tier.id)}
              >
                {pendingTierId === tier.id ? "Menyiapkan pembayaran..." : "Jadi anggota"}
              </button>
            ) : (
              <Link
                className="button-secondary"
                to="/masuk"
                // The profile they were standing on, so signing in returns
                // them to the offer instead of dropping them on Beranda —
                // `LoginPage` reads `location.state.from`.
                state={{ from: backHere }}
              >
                Masuk untuk jadi anggota
              </Link>
            )}
          </li>
        ))}
      </ul>
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
