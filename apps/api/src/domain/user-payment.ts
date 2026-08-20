import { computeNextBillingDate } from "./billing-cycle";

/**
 * Prefixes the `external_id` of every user-subscription invoice.
 *
 * Xendit delivers ONE webhook stream, and the community-scoped handler already
 * resolves its own invoices by treating `external_id` as a bare `transaction.id`
 * uuid. A user-subscription invoice must be distinguishable WITHOUT GUESSING —
 * so it is namespaced here, the webhook routes on the prefix, and anything
 * matching neither shape is IGNORED rather than assumed to be either.
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
 * The two shapes an `external_id` on a DIUDARA invoice can legitimately have.
 *
 * A community invoice carries a BARE `transaction.id` uuid (`StartCheckout`
 * passes `transaction.id` straight through), and a user-subscription invoice
 * carries `usub_<user_transaction.id>`. Nothing else is ours.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a delivered `external_id` belongs. `unknown` is a real answer, not a failure. */
export type InvoiceRoute =
  | { kind: "user"; transactionId: string }
  | { kind: "community"; transactionId: string }
  | { kind: "unknown" };

/**
 * Decides which handler a delivered `external_id` belongs to — the whole reason
 * this namespace exists.
 *
 * Xendit delivers ONE webhook stream to ONE public endpoint, and the two flows
 * that mint invoices in this codebase have different ideas about what an
 * `external_id` is. Routing therefore happens on SHAPE, before a database is
 * touched, and it has exactly three answers:
 *
 *  - `usub_<uuid>`  → a user subscription (Phase 5a).
 *  - `<uuid>`       → a community subscription — `StartCheckout` puts a bare
 *                     `transaction.id` on the wire, so this is the shape every
 *                     invoice `/dashboard/*` has ever opened carries. Handed
 *                     back verbatim and unsliced.
 *  - anything else  → `unknown`. NOT an error, and above all NOT a guess: it is
 *                     somebody else's invoice, or a probe. Neither handler may
 *                     be asked to resolve it.
 *
 * THE UUID CHECK ON THE USER BRANCH IS NOT DECORATION. Stripping the prefix off
 * `"usub_"` yields `""` and off `"usub_x"` yields `"x"`; Task 6's re-review
 * measured both reaching the driver as `invalid input syntax for type uuid`, and
 * this endpoint is PUBLIC — every throw is a 500 that anyone holding the static
 * callback token can trigger at will. The repositories carry their own uuid
 * guards as the second line; this is the first, and it is the one that decides a
 * junk id is nobody's rather than ours-but-broken.
 *
 * Case-insensitive because Postgres accepts either case for a `uuid`, so an
 * upper-case delivery of an id we really minted must not read as junk.
 */
export function routeInvoiceExternalId(externalId: string): InvoiceRoute {
  const userTransactionId = userTransactionIdFromExternalId(externalId);
  if (userTransactionId !== null) {
    // Namespaced, so it is ours or it is nothing — it must never fall through to
    // the community branch below, which would look `usub_…`'s uuid up in the
    // wrong table and 404 a payment that really is ours.
    return UUID_PATTERN.test(userTransactionId)
      ? { kind: "user", transactionId: userTransactionId }
      : { kind: "unknown" };
  }
  return UUID_PATTERN.test(externalId)
    ? { kind: "community", transactionId: externalId }
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
 * WHY THIS IS AN INSTANT AND NOT A DATE. `subscription.next_billing_date` under
 * `/dashboard/*` is a Postgres `date` — it names a DAY — but
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
