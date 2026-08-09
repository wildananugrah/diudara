import { NotFoundError } from "../errors";
import { REMINDER_STAGES, type ReminderStage } from "../../domain/renewal-schedule";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type {
  RenewalReminderContext,
  SubscriptionRepositoryPort,
} from "../ports/subscription-repository.port";
import { REMINDABLE_COMMUNITY_STATUSES } from "./process-renewals";

/** `activity_log.event_type` for a reminder that reached the member. */
export const RENEWAL_REMINDER_SENT = "renewal_reminder_sent";

/**
 * `activity_log.event_type` for a claimed reminder that was deliberately not delivered
 * — the member cancelled, or the community was archived, between the pass claiming the
 * stage and this handler running.
 */
export const RENEWAL_REMINDER_NOT_SENT = "renewal_reminder_not_sent";

/**
 * Subscription statuses a renewal reminder may be sent for.
 *
 * An outbox row can sit for a long time — a provider outage, a stopped worker, a
 * reclaimed row — so entitlement has to be re-read as it is NOW rather than assumed
 * from when the stage was claimed. Dunning somebody who has already cancelled is worse
 * than saying nothing at all.
 *
 * An allowlist, so a status added later is silent until somebody decides it should be
 * chased.
 */
const REMINDABLE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["active", "past_due"]);

/** The Indonesian month names, for the due date in the message. */
const MONTHS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/**
 * How each billing cycle reads in the message. `membership_tier.billing_cycle` is a
 * varchar rather than an enum, so an unrecognised value is physically possible — and
 * unlike `computeNextBillingDate`, which throws because it is about to write a date,
 * this must NOT throw: spec §8 says a tier edited or broken mid-cycle still gets its
 * member reminded, with the amount we recorded. An unknown cycle simply loses the
 * period suffix.
 */
const BILLING_PERIOD_ID: Record<string, string> = {
  monthly: "per bulan",
  quarterly: "per 3 bulan",
  yearly: "per tahun",
};

/**
 * The one line that differs per stage, in Indonesian.
 *
 * Distinct per stage on purpose: a member who receives the same sentence four times
 * has no way to tell that their access is now days from being revoked. The pre-due
 * stage deliberately does NOT mention revocation — nothing has been lost yet — and the
 * final one deliberately does.
 */
const STAGE_HEADLINE_ID: Record<ReminderStage, string> = {
  pre_3d: "Keanggotaan Anda akan berakhir dalam 3 hari.",
  due: "Keanggotaan Anda berakhir hari ini.",
  overdue_1d: "Pembayaran perpanjangan Anda sudah lewat 1 hari.",
  overdue_3d: "Pembayaran perpanjangan Anda sudah lewat 3 hari. Mohon segera diselesaikan.",
  overdue_7d:
    "Pengingat terakhir: pembayaran perpanjangan Anda sudah lewat 7 hari, dan akses Anda " +
    "ke grup komunitas akan segera dicabut.",
};

export interface SendRenewalReminderInput {
  subscriptionId: string;
  stage: ReminderStage;
}

export interface SendRenewalReminderResult {
  /** Whether the member was actually messaged. */
  sent: boolean;
  /** Set when nothing was sent, saying why. Recorded in `activity_log` too. */
  skippedReason?: string;
}

/**
 * Delivers one renewal reminder: a WhatsApp message with a FRESH CHECKOUT LINK.
 *
 * Handled by the outbox worker, one row per (subscription, stage), enqueued by
 * `ProcessRenewals`. Four rules shape every line below:
 *
 *  1. THE MEMBER IS REACHED OVER WHATSAPP, ALWAYS. `notifier` is a single provider and
 *     not the gating map for a reason: `TelegramBotAdapter.notify` THROWS, because it
 *     addresses a WhatsApp number it has no way to reach. A community whose only
 *     channel is a Telegram group is the ordinary case, and routing its reminder to the
 *     provider that gates it would mean nobody is ever told.
 *  2. THE LINK COMES FROM CONFIGURATION. `appBaseUrl` is the value `resolveAppBaseUrl`
 *     produces — the same origin Phase 3 builds `success_redirect_url` from. A
 *     hardcoded host would send every member of every deployment to one developer's
 *     laptop, and no test on that laptop would notice.
 *  3. NO INVITE LINK, ANYWHERE. Not in the message, not in a log line, not in
 *     `activity_log`. The member already holds theirs; an invite link is a bearer
 *     credential, and a credential quoted in more places is one that is more likely to
 *     be forwarded. This use-case never reads one, which is the cheapest way to
 *     guarantee it.
 *  4. A FAILED SEND MUST NOT UNCLAIM THE STAGE. See the class docstring's note below.
 *
 * ==========================================================================
 * WHY A FAILURE HERE NEVER TOUCHES `renewal_reminder`
 *
 * The `renewal_reminder` row means "this stage is CLAIMED", not "this message was
 * delivered". So when the provider fails, this use-case throws and lets the outbox
 * retry — and it deliberately does NOT delete the row, which is why it has no
 * `RenewalReminderRepositoryPort` at all.
 *
 * The two failure directions are not symmetrical. Retrying a send can at worst deliver
 * one duplicate message, which reads as a nuisance. Releasing the claim would let the
 * NEXT reminder pass — running on its own schedule, minutes or hours later — claim the
 * same stage again and enqueue a second row; and if the first row then succeeds on its
 * retry, the member is messaged twice for one stage, which is the exact double-send the
 * unique `(subscription_id, stage)` index exists to prevent. One is a nuisance, the
 * other is the bug.
 * ==========================================================================
 */
export class SendRenewalReminder {
  constructor(
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    /**
     * How the MEMBER is reached: WhatsApp. Separate from any gating provider on
     * purpose — see rule 1 above.
     */
    private readonly notifier: MessagingProviderPort,
    /**
     * `appBaseUrl` is the public origin of `apps/web`, with no trailing slash, exactly
     * as `StartCheckout` receives it. Configuration, not a port, which is why it
     * arrives as a plain value.
     */
    private readonly config: { appBaseUrl: string }
  ) {}

  async execute(input: SendRenewalReminderInput): Promise<SendRenewalReminderResult> {
    const context = await this.subscriptions.findRenewalContext(input.subscriptionId);
    if (!context) {
      // Throwing, not skipping: the row's payload named a subscription that is not
      // there, which is either a deleted row or a bug, and both deserve to be visible
      // in `outbox.last_error` after the bounded retries.
      throw new NotFoundError(`subscription ${input.subscriptionId} not found`);
    }
    const { subscription, tier, community } = context;

    if (!REMINDABLE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      return this.skip(context, input.stage, "subscription_not_renewable", {
        subscriptionStatus: subscription.status,
      });
    }

    if (!REMINDABLE_COMMUNITY_STATUSES.has(community.status)) {
      // The community was archived between the pass claiming this stage and this row
      // being handled. `ProcessRenewals` refuses to enqueue for an archived community;
      // this is the same rule applied at the other end of the queue, because the queue
      // is where time passes.
      return this.skip(context, input.stage, "community_not_accepting_renewals", {
        communityStatus: community.status,
      });
    }

    const member = await this.members.findById(subscription.memberId);
    if (!member) {
      // `subscription.member_id` is a foreign key, so this cannot happen without the
      // database having been edited by hand. Throwing beats notifying nobody.
      throw new NotFoundError(
        `member ${subscription.memberId} for subscription ${subscription.id} not found`
      );
    }

    // The send is the point of the whole use-case, so it happens before the audit entry:
    // if only one of the two can happen, it must be the one the member sees. A failure
    // here propagates, the outbox retries, and the claim in `renewal_reminder` is
    // untouched — see the class docstring.
    await this.notifier.notify({
      toWhatsappNumber: member.whatsappNumber,
      message: buildReminderMessage({
        stage: input.stage,
        memberName: member.name,
        communityName: community.name,
        tierName: tier.name,
        priceAmount: tier.priceAmount,
        billingCycle: tier.billingCycle,
        nextBillingDate: subscription.nextBillingDate,
        checkoutUrl: this.checkoutUrl(community.slug),
      }),
    });

    await this.activityLog.record({
      memberId: member.id,
      communityId: community.id,
      eventType: RENEWAL_REMINDER_SENT,
      // Ids and the stage. NEVER the message, the WhatsApp number or the link:
      // `activity_log` is read by creator-facing dashboards.
      metadata: { stage: input.stage, subscriptionId: subscription.id },
    });

    return { sent: true };
  }

  /**
   * The fresh checkout link: the public community page, where the member picks a tier
   * and a NEW invoice is created. Deliberately not a link to an old invoice — one that
   * has expired is worse than no link, because the member believes they have tried.
   *
   * Must stay in step with the `/c/:slug` route in `apps/web/src/App.tsx`, and mirrors
   * `StartCheckout.subscriptionStatusUrl` in shape and in encoding: the slug is
   * generated by `domain/slug.ts` so it should never need escaping, but this string is
   * handed to a member who taps it, and that is not the place to rely on an invariant
   * held somewhere else.
   */
  private checkoutUrl(slug: string): string {
    return `${this.config.appBaseUrl}/c/${encodeURIComponent(slug)}`;
  }

  /** Records a reminder that was claimed and deliberately not delivered. */
  private async skip(
    context: RenewalReminderContext,
    stage: ReminderStage,
    reason: string,
    detail: Record<string, string>
  ): Promise<SendRenewalReminderResult> {
    console.warn(
      `[renewals] not sending the ${stage} reminder for subscription=` +
        `${context.subscription.id}: ${reason} — recorded in activity_log`
    );
    await this.activityLog.record({
      memberId: context.subscription.memberId,
      communityId: context.community.id,
      eventType: RENEWAL_REMINDER_NOT_SENT,
      metadata: { ...detail, reason, stage, subscriptionId: context.subscription.id },
    });
    return { sent: false, skippedReason: reason };
  }
}

/** Whether a value out of a jsonb payload is one of the schedule's stages. */
function isReminderStage(value: unknown): value is ReminderStage {
  return typeof value === "string" && (REMINDER_STAGES as readonly string[]).includes(value);
}

/**
 * Adapts the use-case to `ProcessOutbox`'s handler signature, and is the ONE place the
 * `send_renewal_reminder` payload contract is checked — the same shape, and the same
 * reasoning, as `grantAccessOutboxHandler`.
 *
 * The stage is validated against `REMINDER_STAGES` rather than merely being a string: a
 * row can outlive a deploy that renamed a stage, and an unrecognised value would
 * otherwise reach the message builder and produce a message with a blank sentence where
 * the reason for it should be.
 */
export function sendRenewalReminderOutboxHandler(useCase: SendRenewalReminder) {
  return async (payload: unknown): Promise<void> => {
    if (typeof payload !== "object" || payload === null) {
      throw new Error(
        "send_renewal_reminder outbox payload is not an object (the payload itself is " +
          "deliberately not repeated here)"
      );
    }
    const { subscriptionId, stage } = payload as Record<string, unknown>;
    if (typeof subscriptionId !== "string" || subscriptionId === "") {
      // Says what is wrong WITHOUT echoing the payload: the worker logs this, and
      // Phase 3 found payer PII in provider payloads.
      throw new Error(
        "send_renewal_reminder outbox payload carries no usable string subscriptionId " +
          "(the payload itself is deliberately not repeated here)"
      );
    }
    if (!isReminderStage(stage)) {
      throw new Error(
        "send_renewal_reminder outbox payload carries no recognised reminder stage; " +
          `expected one of ${REMINDER_STAGES.join(", ")} (the payload itself is ` +
          "deliberately not repeated here)"
      );
    }
    await useCase.execute({ subscriptionId, stage });
  };
}

/**
 * The one message the member receives. In Indonesian, because members are — every
 * member-facing string in this product is (see `buildMemberMessage` in
 * grant-channel-access.ts).
 *
 * Built in one place rather than assembled across the use-case for the same reason that
 * one is: it is the entire member-visible surface of this feature, and what may and may
 * not appear in it (an amount yes, an invite link never) is easier to check when it is
 * all here.
 */
function buildReminderMessage(input: {
  stage: ReminderStage;
  memberName: string | null;
  communityName: string;
  tierName: string;
  priceAmount: number;
  billingCycle: string;
  nextBillingDate: string | null;
  checkoutUrl: string;
}): string {
  const period = BILLING_PERIOD_ID[input.billingCycle];
  const amount =
    period === undefined
      ? formatRupiah(input.priceAmount)
      : `${formatRupiah(input.priceAmount)} ${period}`;

  const lines = [
    input.memberName === null || input.memberName === "" ? "Halo!" : `Halo ${input.memberName},`,
    "",
    STAGE_HEADLINE_ID[input.stage],
    "",
    `Komunitas: ${input.communityName}`,
    `Paket: ${input.tierName}`,
    `Biaya perpanjangan: ${amount}`,
  ];

  const dueDate = formatIndonesianDate(input.nextBillingDate);
  if (dueDate !== null) {
    lines.push(`Jatuh tempo: ${dueDate}`);
  }

  lines.push("");
  lines.push("Perpanjang sekarang di tautan berikut:");
  lines.push(input.checkoutUrl);
  lines.push("");
  lines.push(
    "Setelah pembayaran Anda kami terima, keanggotaan diperpanjang otomatis dan Anda tetap " +
      "berada di grup — tidak perlu keluar atau bergabung ulang."
  );

  return lines.join("\n");
}

/**
 * `50000` -> `"Rp50.000"`.
 *
 * Hand-rolled rather than `Intl.NumberFormat("id-ID", { style: "currency" })`, which
 * puts a NON-BREAKING space between the symbol and the digits and varies with the ICU
 * build. This string is asserted on in tests and read by members; neither wants an
 * invisible character that depends on the runtime.
 */
function formatRupiah(amount: number): string {
  const digits = Math.trunc(Math.abs(amount)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp${amount < 0 ? "-" : ""}${grouped}`;
}

/**
 * `"2026-03-10"` -> `"10 Maret 2026"`, or null when there is no date to name.
 *
 * Parsed structurally out of the `date` column's own format rather than through a
 * `Date`, so no timezone is involved at all: the column names a day, and the member is
 * told that day.
 */
function formatIndonesianDate(dateColumnValue: string | null): string | null {
  if (dateColumnValue === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateColumnValue);
  if (!match) return null;
  const month = MONTHS_ID[Number(match[2]) - 1];
  if (month === undefined) return null;
  return `${Number(match[3])} ${month} ${match[1]}`;
}
