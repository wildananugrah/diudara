import { formatRupiah } from "../api";

/**
 * How a membership tier reads in Bahasa — the words shared by the two screens
 * that render `user_tier` rows: the owner's editor in Pengaturan
 * (`MembershipSettings`) and the offer a visitor sees on a profile
 * (`MembershipOffer`).
 *
 * Its own module rather than a copy in each, because the two screens showing
 * the SAME tier different words is a defect a reader would meet without any
 * test noticing — and a second copy is how that starts. `dashboard/format.ts`
 * has an equivalent over the OTHER tier table and is deliberately not imported
 * from: that is a separate app for a separate account type which Phase 8
 * deletes, so a member-facing screen importing from it would have to be
 * rewritten then (the same reasoning `apiClient.ts` records for that whole
 * directory).
 */

/**
 * `monthly` -> "per bulan". An unknown cycle passes through rather than being
 * hidden: `user_tier.billing_cycle` is a varchar precisely so 5b can add
 * values without a migration (spec §4), and a tier this app cannot name is
 * still a tier its owner is selling and a visitor may buy. 5a only ever writes
 * `monthly`, so only that case is spelled out — a list of cycles this table
 * cannot contain yet would be fiction.
 */
export function billingCycleLabel(cycle: string): string {
  return cycle === "monthly" ? "per bulan" : cycle;
}

/**
 * A tier's price, the way a person should read it — "Gratis" for a free tier
 * rather than "Rp 0". `priceAmount === 0` IS the definition of a free tier,
 * all the way out to `user_subscription.kind` on the API side (see
 * `ManageUserTiers.create`'s own docstring for why there is no separate
 * flag) — "Rp 0" is technically correct and reads like a broken price tag,
 * not like an offer. Takes the raw amount rather than a `UserTier`, so it
 * can be reused wherever a price needs to render without importing the
 * whole tier shape — currently `MembershipSettings`'s own editor.
 */
export function formatTierPrice(amount: number): string {
  return amount === 0 ? "Gratis" : formatRupiah(amount);
}
