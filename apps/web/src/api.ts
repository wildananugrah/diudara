/**
 * Retire-telegram Task 1: this file used to be the old world's public-checkout
 * client — `fetchCommunity`, `startCheckout`, `submitJoinRequest`,
 * `fetchJoinRequestStatus`, `fetchSubscriptionStatus`, `fetchWatchSession`,
 * and the response-shape interfaces those functions returned. Phase 8
 * deleted every screen that called them (`pages/CheckoutPage.tsx`,
 * `pages/StatusPage.tsx`, `pages/RequestStatusPage.tsx`,
 * `pages/WatchPage.tsx`, and `dashboard/apiClient.ts`), so they were
 * deleted here too rather than left dangling and unreachable.
 *
 * `ApiError` and `formatRupiah` survive: both are still imported by the new
 * world (`user/apiClient.ts`, `user/MembershipOffer.tsx`,
 * `user/MembershipSettings.tsx`) for the member-side membership/payout
 * surface, which reuses this file's error type and Rupiah formatter rather
 * than duplicating them.
 */

/** Thrown for any non-2xx response from the API. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Formats an integer-Rupiah amount for Indonesian readers, e.g. 50000 -> "Rp 50.000".
 * Never do arithmetic on the formatted string — this is display-only.
 */
export function formatRupiah(amount: number): string {
  return `Rp ${Math.trunc(amount).toLocaleString("id-ID")}`;
}
