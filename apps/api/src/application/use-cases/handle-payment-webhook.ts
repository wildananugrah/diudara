import { NotFoundError, ValidationError } from "../errors";
import type { PaymentActivationUnitOfWorkPort } from "../ports/payment-activation-unit-of-work.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/** The one provider status that turns money into access. Compared exactly. */
const PAID = "PAID";

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
 * Turns a verified provider payment event into access.
 *
 * The threat model this is shaped by: Xendit authenticates callbacks with a
 * STATIC `X-CALLBACK-TOKEN` header, not an HMAC over the payload. The token
 * therefore authenticates the SENDER, not the message — anyone who obtains it
 * can forge ANY event — and it carries no nonce or timestamp, so it provides no
 * replay protection whatsoever. Two consequences run through every line below:
 *
 *  1. Nothing from the body is authoritative. The amount is compared against
 *     OUR OWN `transaction.amount`, looked up by `external_id`.
 *  2. Replay defence is entirely `webhook_event.provider_event_id` (UNIQUE),
 *     arbitrated by the database.
 *
 * The order is load-bearing and each step is pinned by a test:
 *
 *  1. Find our transaction. Unknown → 404, and nothing is recorded — recording
 *     first would burn the event id, so the retry after we fixed whatever was
 *     wrong would be swallowed as a replay.
 *  2. Compare amounts. Mismatch → 400 + a security log line, before anything is
 *     written. This also denies a forger the ability to consume the event id
 *     that a genuine delivery needs.
 *  3. `recordIfNew`. Already seen → return, touching nothing.
 *  4. Only for `status === "PAID"`: activate, then write the audit entry.
 *
 * Steps 3 and 4 run inside ONE unit of work, so claiming the event id and using
 * it commit together or not at all — see `PaymentActivationUnitOfWorkPort` for
 * the failure that forces this. Steps 1 and 2 stay outside it: they are reads,
 * and a body that fails them should not open a transaction at all.
 */
export class HandlePaymentWebhook {
  constructor(
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly unitOfWork: PaymentActivationUnitOfWorkPort
  ) {}

  async execute(input: HandlePaymentWebhookInput): Promise<HandlePaymentWebhookResult> {
    const transaction = await this.subscriptions.findTransactionByExternalId(input.externalId);
    if (!transaction) {
      throw new NotFoundError("unknown transaction");
    }

    if (input.amount !== transaction.amount) {
      // A forged body claiming amount 1 for a 50,000 tier is the whole reason
      // this comparison exists, so it is worth knowing about. Ids and integers
      // only — the payload carries the payer's name and email, and this line
      // goes to stderr.
      console.warn(
        `[security] webhook amount mismatch: provider=xendit ` +
          `transaction=${transaction.id} expected=${transaction.amount} ` +
          `claimed=${input.amount} event=${safeLabel(input.eventType)}`
      );
      throw new ValidationError("webhook amount does not match our record");
    }

    return this.unitOfWork.run(async (repositories) => {
      const isNew = await repositories.webhookEvents.recordIfNew({
        provider: "xendit",
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload,
      });
      if (!isNew) {
        return { activated: false, duplicate: true };
      }

      if (input.status !== PAID) {
        // Recorded (so a replay of THIS event is a no-op) but not acted on.
        // Phase 3 stops at the first successful payment; expiry/failure handling
        // is a later phase's job.
        //
        // Probed before this line existed: a `SETTLED` delivery returned HTTP
        // 200, left the subscription `pending`, wrote the webhook_event row, and
        // printed NOTHING. `EXPIRED`, `SETTLED`, a typo, and a status Xendit adds
        // next year were all indistinguishable from success on the wire. Given
        // that XenditPaymentAdapter is explicitly unverified against the live
        // API, "a real payment status we do not recognise" is the most likely
        // production failure — and it was the one this system could not report.
        //
        // Ids and enum values only, sanitised: never the raw payload.
        console.warn(
          `[payments] webhook recorded but NOT actioned: provider=xendit ` +
            `transaction=${transaction.id} subscription=${transaction.subscriptionId} ` +
            `status=${safeLabel(input.status)} event=${safeLabel(input.eventType)} ` +
            `activated=false (only ${PAID} activates)`
        );
        return { activated: false, duplicate: false };
      }

      const { subscription, communityId } = await repositories.subscriptions.markPaid({
        transactionId: transaction.id,
        gatewayReferenceId: input.invoiceId,
        paidAt: new Date(),
      });

      await repositories.activityLog.record({
        memberId: subscription.memberId,
        communityId,
        eventType: "joined",
        // Ids and integers only: `webhook_event.payload` is where the raw body
        // lives, and this table is read by creator-facing dashboards.
        metadata: {
          source: "xendit_webhook",
          transactionId: transaction.id,
          subscriptionId: subscription.id,
          amount: transaction.amount,
        },
      });

      return { activated: true, duplicate: false };
    });
  }
}
