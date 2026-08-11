import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../../domain/watch-token";
import { NotFoundError } from "../errors";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { ClockPort } from "../ports/clock.port";
import type { EventRepositoryPort } from "../ports/event-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/** The one `event.status` a watch link may legitimately be sent for. */
const LIVE_STATUS = "live";

/**
 * The one subscription status that entitles a member to a watch link — the same
 * `ENTITLED_STATUS` `AuthoriseStream` requires on every read, deliberately narrower
 * than the `RENEWABLE_STATUSES` channel-gating uses (a grace-period member keeps
 * their Telegram access but not this).
 */
const ENTITLED_STATUS = "active";

/** `activity_log.event_type` for one member successfully notified. */
export const STREAM_LIVE_NOTIFIED_EVENT = "stream_live_notified";

/** `activity_log.event_type` for one member deliberately NOT notified, and why. */
export const STREAM_LIVE_NOTIFY_SKIPPED_EVENT = "stream_live_notify_skipped";

/**
 * `skippedReason`/`activity_log.metadata.reason` for a subscription that is
 * simply not `active` (churned, past_due, cancelled, pending). The common case.
 */
export const SUBSCRIPTION_NOT_ACTIVE_REASON = "subscription_not_active";

/**
 * A SEPARATE reason from `SUBSCRIPTION_NOT_ACTIVE_REASON` — review round 2. The
 * subscription IS `active`; it simply belongs to a different community than the
 * event does. This should be unreachable (the id came out of a roster
 * `HandleStreamLifecycle` built by querying subscriptions FOR this event's own
 * community), but a defensive check earns its own label: collapsing it into
 * `subscription_not_active` would render "anggota sudah tidak aktif" for a
 * member who is, in fact, perfectly active — just not entitled to THIS stream —
 * which is a wrong answer to give a creator asking why someone wasn't told.
 */
export const SUBSCRIPTION_WRONG_COMMUNITY_REASON = "subscription_wrong_community";

export interface NotifyStreamLiveInput {
  eventId: string;
  subscriptionId: string;
}

export interface NotifyStreamLiveResult {
  /** Whether this ONE member actually received a watch link. */
  notified: boolean;
  /** Set when nothing was sent, saying why. Recorded in `activity_log` too. */
  skippedReason?: string;
}

/**
 * The consumer of `HandleStreamLifecycle`'s `notify_stream_live` outbox row: a
 * creator went live, and ONE member of the community gets a WhatsApp message with a
 * link to watch.
 *
 * ONE ROW, ONE MEMBER — same shape as `SendRenewalReminder`, and for the review's
 * ruling that produced it: a single row fanning out to an entire community's roster
 * broke `ProcessOutbox`'s staleness model and could duplicate the whole community's
 * messages under a reclaim. See `OUTBOX_NOTIFY_STREAM_LIVE`'s own docstring for the
 * full reasoning; this class is simply the one-member send that shape implies.
 *
 * ==========================================================================
 * WHAT HAS CHANGED BY THE TIME THIS ROW IS DELIVERED? (the question this
 * project made a rule after Phase 5)
 *
 * An outbox row can sit for a while — a provider outage, a stopped worker, a
 * reclaimed row — and TWO things can have changed since `HandleStreamLifecycle`
 * enqueued this one, neither of which the payload (`eventId`, `subscriptionId`) can
 * tell this class about on its own:
 *
 *   1. THE EVENT MAY HAVE ENDED. `execute` re-reads the event FRESH
 *      (`EventRepositoryPort.findById`) and refuses to send anything unless its
 *      status is STILL `live`, right now. Sending a watch link to a session that has
 *      already finished is worse than sending nothing — the member taps it, watches
 *      a spinner, and blames the product. The skip is RECORDED, not silent.
 *   2. THIS MEMBER MAY HAVE CHURNED. The entitlement is resolved via
 *      `SubscriptionRepositoryPort.findByIdWithCommunity` — the SAME read
 *      `AuthoriseStream` uses for its own entitlement re-check — executed HERE, not
 *      trusted from the roster `HandleStreamLifecycle` built at go-live time.
 * ==========================================================================
 *
 * A RETRY CAN DUPLICATE A MESSAGE TO THIS ONE MEMBER, and that is accepted rather
 * than guarded against with a claim table. `(eventId, subscriptionId)` would be
 * exactly as natural an idempotency key as `renewal_reminder`'s
 * `(subscription_id, stage)`, which this codebase already ships — this is not a case
 * of no such key existing. The reason one was not added is that a watch token is a
 * STATELESS HMAC (`domain/watch-token.ts`): re-minting one for a retry creates no
 * provider-side artifact. That is categorically different from Phase 4's Telegram
 * invite link, where a re-mint produced a SECOND LIVE, UNKILLABLE credential — a
 * security bug, not a nuisance. A duplicate "we're live" WhatsApp message is the
 * nuisance side of that distinction, and it is judged cheaper than a claim table this
 * particular credential does not need.
 */
export class NotifyStreamLive {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    /**
     * How the MEMBER is reached: WhatsApp, always. Separate from any gating
     * provider for the same reason `SendRenewalReminder.notifier` is —
     * `TelegramBotAdapter.notify` throws, since it addresses a WhatsApp
     * number it has no way to reach.
     */
    private readonly notifier: MessagingProviderPort,
    /**
     * INJECTED, never `Date.now()` read inline — same rule `ClockPort`'s own
     * docstring states and `watch-token.ts` enforces structurally (`mintWatchToken`
     * takes `now` as a parameter, not a global read). Production wires
     * `SystemClock`, the same one instance `bootstrapWorker()` already keeps for
     * the renewal and churn passes.
     */
    private readonly clock: ClockPort,
    private readonly config: { appBaseUrl: string; streamTokenSecret: string }
  ) {}

  async execute(input: NotifyStreamLiveInput): Promise<NotifyStreamLiveResult> {
    const event = await this.events.findById(input.eventId);
    if (!event) {
      // `eventId` came out of the API's own outbox payload, written moments
      // earlier by `HandleStreamLifecycle` from a row it had just read. This
      // codebase has no path that deletes an event, so this should be
      // unreachable — but throwing beats silently notifying nobody, and it
      // gives an operator something to see in `outbox.last_error` if it ever
      // does happen.
      throw new NotFoundError(`event ${input.eventId} not found`);
    }

    if (event.status !== LIVE_STATUS) {
      // See the class docstring, point 1.
      return this.skip(event.communityId, input, null, "event_not_live", {
        eventStatus: event.status,
      });
    }

    // See the class docstring, point 2 — the fresh, at-delivery-time entitlement read.
    const entitlement = await this.subscriptions.findByIdWithCommunity(input.subscriptionId);
    if (!entitlement) {
      // Same reasoning as the missing-event branch above: the id came out of our own
      // payload moments ago, so a genuine miss means a bug, not a churn. A churn is a
      // STATUS change on a row that still exists, which is the branch just below.
      throw new NotFoundError(`subscription ${input.subscriptionId} not found`);
    }
    if (entitlement.subscription.status !== ENTITLED_STATUS) {
      return this.skip(
        event.communityId,
        input,
        entitlement.subscription.memberId,
        SUBSCRIPTION_NOT_ACTIVE_REASON,
        { subscriptionStatus: entitlement.subscription.status }
      );
    }
    if (entitlement.communityId !== event.communityId) {
      // See `SUBSCRIPTION_WRONG_COMMUNITY_REASON`'s own docstring: should be
      // unreachable, but a distinct reason rather than folding into the branch
      // above — this member IS active, just not for this event's community.
      return this.skip(
        event.communityId,
        input,
        entitlement.subscription.memberId,
        SUBSCRIPTION_WRONG_COMMUNITY_REASON,
        { subscriptionStatus: entitlement.subscription.status }
      );
    }

    const member = await this.members.findById(entitlement.subscription.memberId);
    if (!member) {
      // `subscription.member_id` is a foreign key; cannot happen without the
      // database edited by hand. Throwing beats silently notifying nobody.
      throw new NotFoundError(`member ${entitlement.subscription.memberId} not found`);
    }

    const token = mintWatchToken({
      subscriptionId: input.subscriptionId,
      eventId: event.id,
      now: this.clock.now().getTime(),
      ttlMs: WATCH_TOKEN_TTL_MS,
      secret: this.config.streamTokenSecret,
    });

    await this.notifier.notify({
      toWhatsappNumber: member.whatsappNumber,
      message: buildLiveMessage({ eventTitle: event.title, watchUrl: this.watchUrl(token) }),
    });

    // Written AFTER the send succeeds, and ONLY here — never before a possible
    // throw. A row whose send fails is retried by the outbox from a clean slate
    // (re-check event, re-check entitlement, re-mint, re-send); if this line ran
    // unconditionally before the send, every retry would add ANOTHER "notified" row
    // for a member who was told once, or zero — the same `renewal_reminder_queued`
    // vs. `_sent` double-count trap this codebase has already documented once.
    await this.activityLog.record({
      memberId: member.id,
      communityId: event.communityId,
      eventType: STREAM_LIVE_NOTIFIED_EVENT,
      metadata: { eventId: event.id, subscriptionId: input.subscriptionId },
    });

    return { notified: true };
  }

  /** Records a member deliberately NOT notified, and answers the skip. */
  private async skip(
    communityId: string,
    input: NotifyStreamLiveInput,
    memberId: string | null,
    reason: string,
    detail: Record<string, string>
  ): Promise<NotifyStreamLiveResult> {
    await this.activityLog.record({
      memberId,
      communityId,
      eventType: STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
      metadata: {
        ...detail,
        reason,
        eventId: input.eventId,
        subscriptionId: input.subscriptionId,
      },
    });
    return { notified: false, skippedReason: reason };
  }

  private watchUrl(token: string): string {
    return `${this.config.appBaseUrl}/watch/${token}`;
  }
}

/**
 * Adapts the use-case to `ProcessOutbox`'s handler signature, and is the ONE place
 * the `notify_stream_live` payload contract is checked — same shape and reasoning as
 * `grantAccessOutboxHandler`.
 */
export function notifyStreamLiveOutboxHandler(useCase: NotifyStreamLive) {
  return async (payload: unknown): Promise<void> => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("eventId" in payload) ||
      typeof payload.eventId !== "string" ||
      payload.eventId === "" ||
      !("subscriptionId" in payload) ||
      typeof payload.subscriptionId !== "string" ||
      payload.subscriptionId === ""
    ) {
      // Says what is wrong WITHOUT echoing the payload — same rule as
      // `grantAccessOutboxHandler`.
      throw new Error(
        "notify_stream_live outbox payload carries no usable string eventId and " +
          "subscriptionId (the payload itself is deliberately not repeated here)"
      );
    }
    await useCase.execute({ eventId: payload.eventId, subscriptionId: payload.subscriptionId });
  };
}

/**
 * The one message a member receives. In Indonesian, because members are — see
 * `buildMemberMessage` in `grant-channel-access.ts` for the same rule stated once.
 *
 * `watchUrl` is a single-audience, time-limited link (`WATCH_TOKEN_TTL_MS`, six
 * hours): said plainly, the same way `GrantChannelAccess`'s invite-link message
 * does, because a member who forwards it will otherwise blame us when it stops
 * working for whoever they sent it to.
 */
function buildLiveMessage(input: { eventTitle: string; watchUrl: string }): string {
  return [
    `${input.eventTitle} sudah LIVE sekarang!`,
    "",
    "Tonton di tautan berikut:",
    input.watchUrl,
    "",
    "Tautan ini khusus untuk Anda dan akan kedaluwarsa dalam beberapa jam, jadi jangan dibagikan.",
  ].join("\n");
}
