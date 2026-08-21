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
  /**
   * `PublicUserProfile.membership.viewerIsMember` — the SERVER's answer, from
   * `IsMemberOf`, never a guess made here. `false` for a signed-out visitor by
   * the API's own construction, and `false` for a LAPSED membership, since
   * `IsMemberOf` requires `current_period_end > now`.
   */
  viewerIsMember: boolean;
  /**
   * `PublicUserProfile.membership.viewerMembershipEnded` — the OTHER half of
   * the same server answer, and the reason `viewerIsMember: false` is not
   * enough to decide anything here. `true` means this viewer holds a
   * subscription row that has run out: not a member, and — since Phase 5b —
   * free to buy again, because the purchase retires that row on its way past.
   * It selects a SENTENCE, never whether there is a button. Also `false` for a
   * signed-out visitor, by the same construction.
   *
   * The two are never both `true`: they are projected from one
   * `MembershipStanding` server-side.
   */
  viewerMembershipEnded: boolean;
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
 * AND ONE THING IT SHOWS INSTEAD OF THE BUTTON. **A viewer who already holds a
 * live membership is told so** (fix round 1) rather than offered a purchase of
 * something they already own — `StartUserSubscription` answers that a 409, and
 * while nobody is charged for it, being offered it at all is the defect. The
 * answer is `membership.viewerIsMember`, decided server-side by `IsMemberOf`
 * (Task 8) — the same question Phase 6's paywall asks, and the public profile
 * is the only thing in 5a that puts it on a request path.
 *
 * AND ONE NOTICE THAT SITS ABOVE THE OFFER RATHER THAN REPLACING IT — the part
 * this file has now got wrong twice, in opposite directions.
 *
 * 5a offered a LAPSED member the tier and a button `StartUserSubscription`
 * answered 409 to, permanently: its guard reads the status alone (it has to — a
 * lapsed row let past it collides with `user_subscription_one_active` at
 * activation time, which is money taken and nothing granted), and 5a had nothing
 * that moved such a row. The screen then advised a reload, and the reload
 * re-rendered the same button. So the button was taken away and the screen said
 * *"Perpanjangan belum tersedia untuk saat ini"*.
 *
 * **Phase 5b built the renewal, and this screen did not learn** (the final
 * whole-branch review's C-1). `StartUserSubscription` now retires the lapsed row
 * INSIDE the purchase transaction, so one press frees the unique index's slot and
 * opens a fresh invoice — there is no separate renew endpoint because buying
 * again IS the renewal here (nothing in this system charges anybody twice on its
 * own). A screen with no button meant the only thing that could rescue a lapsed
 * member was the worker's hourly sweep moving the row to `expired`, and if the
 * worker was down, nothing ever could.
 *
 * So the ended state is a NOTICE, not a refusal: the member is told their
 * membership ended, and then offered the tiers underneath it. The one case that
 * still has nothing to press is a creator who has withdrawn every tier — and the
 * sentence there says exactly that, rather than blaming a renewal feature that
 * now exists.
 *
 * Every failure becomes a Bahasa sentence through `errorCopy.ts`
 * (`src/test/no-raw-server-errors.test.ts`), except the 401 — the one failure
 * whose remedy is not a sentence but a destination, exactly as `FollowButton`
 * decided for the same status.
 */
export default function MembershipOffer({
  handle,
  tiers,
  viewerIsMember,
  viewerMembershipEnded,
}: MembershipOfferProps) {
  /** The tier whose purchase is in flight, or `null`. Also what disables every button. */
  const [pendingTierId, setPendingTierId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Declared before the early returns below, with the rest: hooks cannot sit
  // behind a conditional return.
  const navigate = useNavigate();

  /** Where Masuk sends a visitor back to once they are signed in — `LoginPage` reads this. */
  const backHere = `/@${handle}`;

  // FIRST, and before anything is rendered at all — see the docstring: the
  // server refuses a self-purchase and the database forbids the row, so
  // neither the offer nor the membership panel belongs on your own profile.
  if (isOwnHandle(handle)) return null;

  const signedIn = isUserSignedIn();

  // A member sees their membership INSTEAD of the offer, and this comes before
  // the empty-tiers check on purpose: a creator can withdraw every tier while
  // people still hold memberships bought against them (`PATCH
  // /users/me/tiers/:id` deactivates and never deletes, precisely so an
  // existing subscription keeps resolving), and that person is still a member.
  //
  // Gated on `signedIn` as belt-and-braces. The API answers `false` for an
  // anonymous request by construction, so this can only fire on a response
  // that contradicts its own contract — and the failure it prevents is telling
  // a signed-out stranger that they hold somebody's membership.
  if (viewerIsMember && signedIn) {
    return (
      <section className="card stack membership-offer" aria-labelledby="membership-offer-heading">
        <h2 id="membership-offer-heading">Keanggotaan</h2>
        <p data-testid="membership-member">Anda sudah menjadi anggota @{handle}.</p>
      </section>
    );
  }

  // A membership that has ENDED. Not a state that replaces the offer any more —
  // see the docstring: 5b's purchase retires the lapsed row inside its own
  // transaction, so this person may buy, and the only thing standing between
  // them and a renewal used to be this screen.
  //
  // Gated on `signedIn` as belt-and-braces, exactly as above: the API answers
  // `false` for an anonymous request by construction, so this can only fire on
  // a response that contradicts its own contract — and the failure it prevents
  // is telling a signed-out stranger that a membership of theirs ended.
  const membershipEnded = viewerMembershipEnded && signedIn;

  // The one case that still has nothing to press, and it comes BEFORE the plain
  // empty-tiers return for the same reason the member branch does: a creator can
  // withdraw every tier while people still hold (and have held) memberships
  // bought against them, and that person is still owed the news. The sentence
  // names the actual obstacle — this creator is not selling anything today —
  // rather than saying renewal is unavailable, which is the one thing Phase 5b
  // made untrue.
  if (tiers.length === 0) {
    if (!membershipEnded) return null;
    return (
      <section className="card stack membership-offer" aria-labelledby="membership-offer-heading">
        <h2 id="membership-offer-heading">Keanggotaan</h2>
        <p data-testid="membership-ended">
          Keanggotaan Anda di @{handle} sudah berakhir. Kreator ini sedang tidak menawarkan
          paket keanggotaan.
        </p>
      </section>
    );
  }

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
      {membershipEnded ? (
        // ABOVE the list, and it replaces the "dukung" line rather than joining
        // it: this person already supported this creator, and being pitched as
        // though they never had is the wrong thing to read on the way back in.
        <p data-testid="membership-ended">
          Keanggotaan Anda di @{handle} sudah berakhir. Pilih paket di bawah untuk
          memperpanjang.
        </p>
      ) : (
        <p className="muted">Dukung @{handle} dengan menjadi anggota berbayar.</p>
      )}
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
