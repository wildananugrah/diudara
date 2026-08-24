import { computeNextBillingDate } from "./billing-cycle";

/**
 * Prefixes the `external_id` of every invoice this codebase mints.
 *
 * Xendit delivers ONE webhook stream to ONE public endpoint, and that endpoint
 * receives whatever anybody holding the static callback token sends it. An
 * invoice of OURS must therefore be distinguishable WITHOUT GUESSING — so it is
 * namespaced here, the webhook routes on the prefix, and anything else is
 * IGNORED rather than assumed to be ours.
 *
 * THE NAMESPACE OUTLIVED THE REASON IT WAS INTRODUCED. Phase 5a added it to tell
 * a membership invoice apart from a community one, whose `external_id` was a bare
 * `transaction.id` uuid; retire-telegram Task 5 deleted that second kind. The
 * prefix stays, because what it really buys is the ability to say "not ours" at
 * all — see `routeInvoiceExternalId`.
 */
export const USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX = "usub_";

export function userSubscriptionExternalId(transactionId: string): string {
  return `${USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX}${transactionId}`;
}

/** `null` when this external id belongs to something else — never a guess. */
export function userTransactionIdFromExternalId(externalId: string): string | null {
  return externalId.startsWith(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX)
    ? externalId.slice(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX.length)
    : null;
}

/**
 * The ONE shape an `external_id` on a DIUDARA invoice can legitimately have:
 * `usub_<user_transaction.id>`. Nothing else is ours.
 *
 * Retire-telegram Task 5 removed the second: a bare `transaction.id` uuid, which
 * `StartCheckout` put on the wire for every community invoice `/dashboard/*` ever
 * opened. That handler is gone, so a bare uuid is now nobody's.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a delivered `external_id` belongs. `unknown` is a real answer, not a failure. */
export type InvoiceRoute = { kind: "user"; transactionId: string } | { kind: "unknown" };

/**
 * Decides whether a delivered `external_id` is ours at all — the whole reason
 * this namespace exists.
 *
 * Xendit delivers ONE webhook stream to ONE PUBLIC endpoint, authenticated by a
 * static header token that authenticates the SENDER and not the message. Routing
 * therefore happens on SHAPE, before a database is touched, and it has exactly
 * two answers:
 *
 *  - `usub_<uuid>`  → a user subscription.
 *  - anything else  → `unknown`. NOT an error, and above all NOT a guess: it is
 *                     somebody else's invoice, or a probe. No handler may be
 *                     asked to resolve it.
 *
 * TWO ANSWERS IS NOT ONE ANSWER, and this is the line where that matters most.
 * Phase 5a wrote this rule when there were two kinds of invoice, and the obvious
 * thing to do when retire-telegram deleted the second was to collapse it: with
 * one kind left, "not recognised" looks like it must mean "the kind that is
 * left". It does not. `user_transaction` would then be searched for an id that
 * was never one of ours, and — for a uuid that happens to collide, or a delivery
 * an attacker aims deliberately — a membership would be activated against a
 * payment for something else. `unknown` stays a first-class outcome for exactly
 * as long as this endpoint is public, which is for ever.
 *
 * THE UUID CHECK IS NOT DECORATION. Stripping the prefix off `"usub_"` yields
 * `""` and off `"usub_x"` yields `"x"`; Phase 5a's re-review measured both
 * reaching the driver as `invalid input syntax for type uuid`, and every throw
 * here is a 500 anyone holding the callback token can trigger at will. The
 * repositories carry their own uuid guards as the second line; this is the
 * first, and it is the one that decides a junk id is nobody's rather than
 * ours-but-broken.
 *
 * Case-insensitive because Postgres accepts either case for a `uuid`, so an
 * upper-case delivery of an id we really minted must not read as junk.
 */
export function routeInvoiceExternalId(externalId: string): InvoiceRoute {
  const userTransactionId = userTransactionIdFromExternalId(externalId);
  if (userTransactionId === null) {
    // Not namespaced, so not ours. This is the branch that must never learn to
    // guess: falling through to the user path from here is precisely how a
    // payment for something else activates a membership.
    return { kind: "unknown" };
  }
  return UUID_PATTERN.test(userTransactionId)
    ? { kind: "user", transactionId: userTransactionId }
    : { kind: "unknown" };
}

/**
 * When the period a member just paid for runs out —
 * `user_subscription.current_period_end`, which Phase 6's paywall compares
 * against `now()` (spec §8).
 *
 * The month arithmetic is `computeNextBillingDate`'s rather than a second
 * implementation of it, so the clamping comes for free: `setMonth` OVERFLOWS (31
 * January plus a month is 3 March), and a member who paid on the 31st would
 * otherwise gain two days of access every cycle. So does the refusal to guess —
 * `user_tier.billing_cycle` is a varchar and not an enum, so an unrecognised
 * value can physically arrive here, and defaulting to `monthly` would sell a
 * yearly member eleven months of nothing. It throws, which the webhook surfaces
 * as a 500 with the delivery unrecorded and therefore replayable.
 *
 * WHY THIS IS AN INSTANT AND NOT A DATE. `computeNextBillingDate` answers with a
 * `YYYY-MM-DD` DAY, because the column it was written for was a Postgres `date`.
 * `user_subscription.current_period_end` is a `timestamptz`, because the
 * question asked of it is "is this viewer a member RIGHT NOW". Taking only the
 * day and starting it at midnight UTC would end the period BEFORE the instant it
 * was bought at: a member who paid at 11:00 would lose eleven hours of every
 * cycle, and one who paid at 06:00 WIB (23:00 UTC the previous day) would lose
 * most of a day. So the day comes from the shared arithmetic and the time of day
 * comes from the payment.
 */
export function computeUserSubscriptionPeriodEnd(paidAt: Date, billingCycle: string): Date {
  const [year, month, day] = computeNextBillingDate(paidAt, billingCycle).split("-").map(Number);
  return new Date(
    Date.UTC(
      year!,
      month! - 1,
      day!,
      paidAt.getUTCHours(),
      paidAt.getUTCMinutes(),
      paidAt.getUTCSeconds(),
      paidAt.getUTCMilliseconds()
    )
  );
}
