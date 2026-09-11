import {
  computeUserSubscriptionPeriodEnd,
  routeInvoiceExternalId,
} from "../../domain/user-payment";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import type { PaymentActivationUnitOfWorkPort } from "../ports/payment-activation-unit-of-work.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";

/** The one provider status that turns money into access. Compared exactly. */
const PAID = "PAID";

/**
 * `user_transaction.status` — the only value `StartUserSubscription` ever
 * inserts, and the only one this handler will settle.
 */
const TRANSACTION_PENDING = "pending";

/** What `markTransactionPaid` writes. A transaction already here is a duplicate. */
const TRANSACTION_PAID = "paid";

/**
 * Renders an attacker-chosen string safe to put in a log line.
 *
 * `status` and `eventType` reach these logs straight off an untrusted webhook
 * body. The parser bounds their LENGTH but not their characters, so a status of
 * `"PAID\n[security] nothing to see here"` would otherwise forge a second log
 * line — and these lines are what an operator reads when payments look wrong.
 * Everything outside a conservative identifier set becomes `?`, so the value
 * stays diagnosable without becoming trustworthy.
 *
 * This is a LABEL sanitiser, not a redactor: it must only ever be applied to
 * provider enum values and our own ids. The raw payload belongs on
 * `webhook_event.payload` and nowhere else — Xendit callbacks carry the payer's
 * name, email and phone number, and Phase 2 found argon2id hashes leaking
 * through raw error logging.
 */
function safeLabel(value: string): string {
  return value.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "?");
}

export interface HandlePaymentWebhookInput {
  /** Per-delivery replay key, derived by the adapter that parsed the payload. */
  providerEventId: string;
  /** The provider's own invoice id, stored as `transaction.gateway_reference_id`. */
  invoiceId: string;
  /** Our transaction id, echoed back by the provider. */
  externalId: string;
  status: string;
  /** What the BODY claims. Checked against our own record, never trusted. */
  amount: number;
  eventType: string;
  /** The raw body, stored verbatim on `webhook_event.payload` for audit. */
  payload: unknown;
}

export interface HandlePaymentWebhookResult {
  /** True only when this call flipped the subscription to active. */
  activated: boolean;
  /** True when the event had already been recorded and nothing was done. */
  duplicate: boolean;
}

/**
 * Turns a verified provider payment event into an ACTIVE membership.
 *
 * The threat model this is shaped by: Xendit authenticates callbacks with a
 * STATIC `X-CALLBACK-TOKEN` header, not an HMAC over the payload. The token
 * therefore authenticates the SENDER, not the message — anyone who obtains it
 * can forge ANY event — and it carries no nonce or timestamp, so it provides no
 * replay protection whatsoever. Two consequences run through every line below:
 *
 *  1. Nothing from the body is authoritative. The amount is compared against
 *     OUR OWN `user_transaction.amount`, looked up by `external_id`.
 *  2. Replay defence is entirely `webhook_event.provider_event_id` (UNIQUE),
 *     arbitrated by the database.
 *
 * ONE STREAM, AND NOT EVERYTHING ON IT IS OURS. Xendit delivers every callback
 * to one public endpoint. Phase 5a introduced an `external_id` namespace
 * (`usub_<uuid>`) to tell a membership invoice apart from a community one;
 * retire-telegram Task 5 deleted the community half, and the namespace stayed —
 * because what it really buys is the ability to answer "this is not ours at all".
 *
 * THE OUTCOMES ARE TWO, AND COLLAPSING THEM TO ONE IS THE FAILURE THIS FILE
 * EXISTS TO AVOID. With one kind of invoice left, an unrecognised `external_id`
 * looks like it must be that kind. It is not: it is somebody else's invoice or a
 * probe, and resolving it against `user_transaction` is how a payment for
 * something else activates a membership. So the answers stay **user** and
 * **ignored**, decided by `routeInvoiceExternalId` before a database is touched,
 * and `execute` below has no third branch for a future change to widen.
 *
 * The order is load-bearing and each step is pinned by a test:
 *
 *  1. Find our transaction, by the uuid BEHIND the namespace. Unknown → 404, and
 *     nothing is recorded — recording first would burn the event id, so the
 *     retry after we fixed whatever was wrong would be swallowed as a replay.
 *  2. Verify `body.id` against the reference checkout stored
 *     (`attachGatewayReference`), then the amount against OUR OWN
 *     `user_transaction.amount`. Both before anything is written, and both with a
 *     security log line. This also denies a forger the ability to consume the
 *     event id that a genuine delivery needs.
 *  3. `recordIfNew`. Already seen → return, touching nothing.
 *  4. Only for `status === "PAID"`: settle the transaction and activate the
 *     subscription. A transaction already `paid` is a 2xx no-op; one in any other
 *     non-`pending` status is a 409 that records nothing, because a payment for a
 *     reconciled-by-hand row is a person's problem and a 200 would lose it.
 *
 * Steps 3 and 4 run inside ONE unit of work, so claiming the event id and using
 * it commit together or not at all — see `PaymentActivationUnitOfWorkPort` for
 * the failure that forces this. Steps 1 and 2 stay outside it: they are reads,
 * and a body that fails them should not open a transaction at all.
 *
 * WHAT THIS DOES NOT DO, and it is not an omission: no `activity_log` entry and
 * no outbox row. Those were community concepts — a `member`, a `community_id`, a
 * Telegram invite — and a user subscription grants access by being ACTIVE, which
 * is the single index hit the paywall asks for (spec §8). There is nothing to
 * send.
 */
export class HandlePaymentWebhook {
  constructor(
    /**
     * POOLED — used for the reads that decide whether a delivery is worth opening
     * a transaction for at all (steps 1 and 2 above). The writes go through the
     * unit of work's own copy.
     */
    private readonly userSubscriptions: UserSubscriptionRepositoryPort,
    private readonly unitOfWork: PaymentActivationUnitOfWorkPort,
    /**
     * Where `paidAt` comes from. Injected in Phase 5, and not for tidiness: `paidAt` is
     * what the paid period is anchored on, so with a `new Date()` here the period
     * arithmetic could only ever be asserted against whatever day the suite happened to
     * run on.
     *
     * It is the instant WE settled the payment, deliberately, not a timestamp from the
     * callback body. Nothing in that body is authoritative (see above), and a forged
     * `paid_at` would move when a member's access runs out.
     */
    private readonly clock: ClockPort
  ) {}

  async execute(input: HandlePaymentWebhookInput): Promise<HandlePaymentWebhookResult> {
    const route = routeInvoiceExternalId(input.externalId);
    if (route.kind !== "user") {
      // NOT a fallback, and never `else { settle… }`. An `external_id` that is not
      // in our namespace is somebody else's invoice or a probe: it is ignored,
      // never assumed to be the one kind we still sell. Answered 2xx rather than
      // 404 because no fix of ours could ever make it resolvable, so there is
      // nothing for the provider to retry — and nothing is looked up, recorded or
      // logged beyond this line.
      console.warn(
        `[payments] webhook IGNORED, external id is not in our namespace: provider=xendit ` +
          `external_id=${safeLabel(input.externalId)} event=${safeLabel(input.eventType)}`
      );
      return { activated: false, duplicate: false };
    }
    return this.settleUserSubscription(route.transactionId, input);
  }

  /**
   * A paid invoice becomes an ACTIVE membership between two people (spec §7),
   * over `user_subscription`/`user_transaction`.
   *
   * Its step order was modelled on the community handler retire-telegram Task 5
   * deleted, because that order is what several real findings shaped — and none
   * of them may be re-learned here. The class docstring above lists the four
   * steps; the comments below say what each one cost to get right.
   */
  private async settleUserSubscription(
    transactionId: string,
    input: HandlePaymentWebhookInput
  ): Promise<HandlePaymentWebhookResult> {
    const transaction = await this.userSubscriptions.findTransactionById(transactionId);
    if (!transaction) {
      // English at every `NotFoundError` call site, and deliberately vague: this
      // reaches an HTTP response on a public endpoint, and telling a caller
      // anything more about WHY an id missed is telling them which ids are worth
      // guessing.
      throw new NotFoundError("unknown transaction");
    }

    if (transaction.gatewayReferenceId === null) {
      // `StartUserSubscription` writes this immediately after the provider call
      // returns, so an absent reference means that write failed. Fail CLOSED:
      // trusting `body.id` when we have nothing of our own to compare it against
      // is exactly the hole this closes. Checked BEFORE the amount, because this
      // is the anchor the replay guard itself hangs from — `provider_event_id` is
      // derived from `body.id`, so until `body.id` is verified an attacker can
      // mint a fresh event id at will and walk past the UNIQUE constraint.
      // Measured on the deleted community path before this check existed: 12
      // concurrent PAID deliveries with 12 distinct `body.id`s all returned 200
      // and all activated.
      console.warn(
        `[security] user webhook for a transaction with no gateway reference: provider=xendit ` +
          `user_transaction=${transaction.id} event=${safeLabel(input.eventType)} — checkout ` +
          "never recorded the provider invoice id, so this delivery cannot be verified"
      );
      throw new ValidationError("this transaction cannot be verified against the provider");
    }

    if (input.invoiceId !== transaction.gatewayReferenceId) {
      console.warn(
        `[security] webhook invoice id mismatch: provider=xendit ` +
          `user_transaction=${transaction.id} ` +
          `expected=${safeLabel(transaction.gatewayReferenceId)} ` +
          `claimed=${safeLabel(input.invoiceId)} event=${safeLabel(input.eventType)}`
      );
      throw new ValidationError("webhook invoice id does not match our record");
    }

    if (input.amount !== transaction.amount) {
      // OUR figure against THEIR claim, never the other way round. A forged body
      // claiming 1 rupiah for a 50,000 tier is the entire reason this comparison
      // exists. Ids and integers only — the payload carries the payer's name,
      // email and phone number, and this line goes to stderr.
      console.warn(
        `[security] webhook amount mismatch: provider=xendit ` +
          `user_transaction=${transaction.id} expected=${transaction.amount} ` +
          `claimed=${input.amount} event=${safeLabel(input.eventType)}`
      );
      throw new ValidationError("webhook amount does not match our record");
    }

    // The instant WE settled this, not a timestamp off the body: nothing in that
    // body is authoritative, and a forged `paid_at` would move when a member's
    // access runs out. Taken once, so the transaction's `paid_at` and the
    // period's end are measured from the same instant.
    const paidAt = this.clock.now();

    return this.unitOfWork.run(async (repositories) => {
      const isNew = await repositories.webhookEvents.recordIfNew({
        provider: "xendit",
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload,
      });
      if (!isNew) {
        // THE IDEMPOTENCY GUARANTEE, and it is this line rather than anything
        // below it. Redelivery is normal provider behaviour: the second delivery
        // of one event activates nothing and extends no period, because it never
        // reaches the code that could.
        return { activated: false, duplicate: true };
      }

      if (input.status !== PAID) {
        // Recorded, so a replay of THIS event is a no-op, and acted on in no other
        // way. Said out loud for a reason measured once already: an unrecognised
        // status is otherwise indistinguishable from success on the wire — a
        // `SETTLED` delivery returned 200, left the subscription pending, and
        // printed nothing — and `XenditPaymentAdapter` is unverified against the
        // live API, so "a real status we do not recognise" is the most likely
        // production failure. Ids and enum values only, sanitised: never the raw
        // payload.
        console.warn(
          `[payments] webhook recorded but NOT actioned: provider=xendit ` +
            `user_transaction=${transaction.id} ` +
            `user_subscription=${transaction.userSubscriptionId} ` +
            `status=${safeLabel(input.status)} event=${safeLabel(input.eventType)} ` +
            `activated=false (only ${PAID} activates)`
        );
        return { activated: false, duplicate: false };
      }

      // Re-read inside the unit of work, so the status this branches on is the one
      // committed when this transaction began rather than the one the pre-checks
      // above saw on the pool.
      const current = await repositories.userSubscriptions.findTransactionById(transaction.id);
      if (!current) {
        throw new Error(
          `HandlePaymentWebhook: user transaction ${transaction.id} vanished mid-settlement`
        );
      }

      if (current.status !== TRANSACTION_PENDING) {
        if (current.status === TRANSACTION_PAID) {
          // A genuine duplicate that got past the event-id guard — which needs a
          // delivery differing in `body.id` or `status`, or a `webhook_event` row
          // removed by hand. A 2xx is correct: there is nothing to retry, and
          // settling again would move `paid_at` and the period end with it.
          console.warn(
            `[payments] webhook for an already-settled user transaction: provider=xendit ` +
              `user_transaction=${current.id} status=${safeLabel(current.status)} ` +
              `event=${safeLabel(input.eventType)} — no second activation was performed`
          );
          return { activated: false, duplicate: true };
        }
        // Nothing writes any other status, so this is a row somebody reconciled
        // by hand. A real payment has arrived for it, and answering 200
        // is how that payment disappears — Xendit does not retry a 2xx, and once
        // the event id is recorded the delivery cannot be replayed by hand either.
        // So this THROWS, which rolls `recordIfNew` back with it.
        console.warn(
          `[payments] ALERT: a payment arrived for a user transaction that is not settleable: ` +
            `provider=xendit user_transaction=${current.id} ` +
            `user_subscription=${current.userSubscriptionId} status=${safeLabel(current.status)} ` +
            `event=${safeLabel(input.eventType)} amount=${current.amount} — the member has PAID ` +
            "and has NOT been activated. Nothing was recorded, so this delivery can be replayed " +
            "after the row is reconciled by hand."
        );
        throw new ConflictError(
          "this transaction is not in a state that can be settled; it needs manual review"
        );
      }

      const subscription = await repositories.userSubscriptions.findById(
        current.userSubscriptionId
      );
      if (!subscription) {
        // Unreachable while `user_transaction.user_subscription_id` is a foreign
        // key. Not assumed away: throwing rolls the unit of work back, which
        // leaves the delivery replayable, and that is the only safe answer to a
        // payment we cannot place.
        throw new Error(
          `HandlePaymentWebhook: no user subscription for transaction ${current.id}`
        );
      }

      const tier = await repositories.userTiers.findById(subscription.tierId);
      if (!tier) {
        // Unreachable while the composite foreign key holds — same treatment.
        throw new Error(
          `HandlePaymentWebhook: no user tier for subscription ${subscription.id}`
        );
      }

      // Throws on a `billing_cycle` it does not recognise rather than guessing
      // `monthly`, which would sell a yearly member eleven months of nothing. The
      // throw rolls this unit of work back, event id and all, so the delivery can
      // be replayed once the tier is fixed. Computed BEFORE anything is written,
      // so a bad cycle cannot leave a settled transaction behind an unactivated
      // subscription.
      const periodEnd = computeUserSubscriptionPeriodEnd(paidAt, tier.billingCycle);

      // ONE ACTIVE MEMBERSHIP PER (SUBSCRIBER, OWNER) — the shape of accidentally
      // paying twice, and `user_subscription_one_active` is the partial unique
      // index that forbids it. Excluding the row being activated is what keeps a
      // redelivery against THAT row working; without it, the second delivery of a
      // subscription's own activation would refuse itself.
      //
      // THIS PREDICATE IS THE GRACEFUL PATH, NOT THE GUARANTEE. Under READ COMMITTED
      // two concurrent activations cannot see each other's uncommitted row, so both
      // would pass this read; the index is what actually arbitrates, and the loser's
      // unit of work rolls back with the event id unspent, so the provider's retry
      // takes this path and is answered without a 500.
      const active = await repositories.userSubscriptions.findActiveFor(
        subscription.subscriberId,
        subscription.ownerId,
        // The scope THIS subscription is in, taken off the row being
        // activated — never `null`, which would ask about the personal
        // membership while activating a community one.
        subscription.communityId
      );
      if (active !== null && active.id !== subscription.id) {
        // The money ARRIVED, so the transaction settles: hiding that would hide a
        // refund that is owed, and there is no refund path anywhere in this system.
        await repositories.userSubscriptions.markTransactionPaid(current.id, paidAt);
        // And the pending claim is RELEASED. Only the worker's stale-checkout sweep
        // expires a pending `user_subscription`, and `user_subscription_one_pending` means one left
        // behind blocks every later checkout for this pair — a buyer wedged out of
        // a creator by a purchase they already overpaid for.
        await repositories.userSubscriptions.cancel(subscription.id);
        console.warn(
          `[payments] ALERT: a second membership payment for a pair that is already active: ` +
            `provider=xendit user_transaction=${current.id} ` +
            `user_subscription=${subscription.id} active=${active.id} ` +
            `subscriber=${subscription.subscriberId} owner=${subscription.ownerId} ` +
            `amount=${current.amount} event=${safeLabel(input.eventType)} — the payment was ` +
            "recorded, the duplicate subscription was cancelled, no second membership was " +
            "granted, and a refund is likely owed"
        );
        // A 2xx: there is nothing for the provider to retry, and a 500 here would
        // buy nothing but the same failure again.
        return { activated: false, duplicate: false };
      }

      await repositories.userSubscriptions.markTransactionPaid(current.id, paidAt);
      const activated = await repositories.userSubscriptions.activate(subscription.id, periodEnd);
      if (!activated) {
        // Zero rows for an id read two statements ago inside this transaction.
        // Throwing rolls the settlement back rather than reporting an activation
        // that did not happen.
        throw new Error(
          `HandlePaymentWebhook: could not activate user subscription ${subscription.id}`
        );
      }

      return { activated: true, duplicate: false };
    });
  }
}
