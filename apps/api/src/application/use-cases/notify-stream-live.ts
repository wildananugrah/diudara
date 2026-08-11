import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../../domain/watch-token";
import { NotFoundError } from "../errors";
import { redactLinks, safeErrorSummary } from "../log-safety";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { EventRepositoryPort } from "../ports/event-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";

/** The one `event.status` a watch link may legitimately be sent for. */
const LIVE_STATUS = "live";

/** `activity_log.event_type` for a completed notification pass. */
export const STREAM_LIVE_NOTIFIED_EVENT = "stream_live_notified";

/** `activity_log.event_type` for a pass that sent nothing, and why. */
export const STREAM_LIVE_NOTIFY_SKIPPED_EVENT = "stream_live_notify_skipped";

export interface NotifyStreamLiveResult {
  /** How many members actually received a watch link. */
  notified: number;
  /** Set when NOTHING was sent at all — the event was no longer live. */
  skippedReason?: string;
}

/**
 * The consumer of `HandleStreamLifecycle`'s `notify_stream_live` outbox row: a
 * creator went live, and every active member of the community gets a WhatsApp
 * message with a link to watch.
 *
 * ==========================================================================
 * WHAT HAS CHANGED BY THE TIME THIS ROW IS DELIVERED? (the question this
 * project made a rule after Phase 5)
 *
 * An outbox row can sit for a while — a provider outage, a stopped worker, a
 * reclaimed row — and TWO things can have changed since `HandleStreamLifecycle`
 * enqueued this one, neither of which the payload (just `eventId`) can tell
 * this class about on its own:
 *
 *   1. THE EVENT MAY HAVE ENDED. `execute` re-reads the event FRESH
 *      (`EventRepositoryPort.findById`) and refuses to send anything unless its
 *      status is STILL `live`, right now. Sending a watch link to a session
 *      that has already finished is worse than sending nothing — the member
 *      taps it, watches a spinner, and blames the product. The skip is
 *      RECORDED, not silent, so a creator's activity feed can distinguish "we
 *      told everyone" from "the stream ended before we got the chance".
 *   2. A MEMBER MAY HAVE CHURNED. The roster is resolved via
 *      `SubscriptionRepositoryPort.listActiveForCommunity`, which is a fresh
 *      read filtered to `active`, executed HERE — not a list captured at
 *      go-live and carried in the payload. A member who churns between go-live
 *      and delivery is simply absent from that read; there is no separate
 *      per-member re-check because the SQL predicate already is one.
 * ==========================================================================
 *
 * A FAILED SEND IS BEST-EFFORT, NOT ALL-OR-NOTHING. Unlike `SendRenewalReminder`
 * (one row per member), one `notify_stream_live` row fans out to an entire
 * community, so a single member's provider failure must not stop the rest from
 * being told the stream is up. Each send is therefore attempted independently;
 * failures are collected and, if any occurred, rethrown ONCE at the end so the
 * outbox row retries. That retry CAN duplicate a message to a member who was
 * already notified successfully on an earlier attempt — there is no per-member
 * idempotency key the way `channel_membership`'s unique index gives
 * `GrantChannelAccess` one. Judged the right tradeoff anyway, for the same
 * reason `SendRenewalReminder`'s docstring gives for its own asymmetric
 * failure direction: a duplicate "we're live" message is a nuisance: telling
 * nobody because one provider call blipped is the bug.
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
    private readonly config: { appBaseUrl: string; streamTokenSecret: string }
  ) {}

  async execute(input: { eventId: string }): Promise<NotifyStreamLiveResult> {
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
      // See the class docstring, point 1. Recorded rather than merely logged:
      // a creator's activity feed should be able to say why nobody was told.
      await this.activityLog.record({
        memberId: null,
        communityId: event.communityId,
        eventType: STREAM_LIVE_NOTIFY_SKIPPED_EVENT,
        metadata: { eventId: event.id, reason: "event_not_live", eventStatus: event.status },
      });
      return { notified: 0, skippedReason: "event_not_live" };
    }

    // See the class docstring, point 2 — this is the fresh, at-delivery-time read.
    const activeSubscriptions = await this.subscriptions.listActiveForCommunity(event.communityId);

    const failures: string[] = [];
    let notified = 0;

    for (const subscription of activeSubscriptions) {
      const member = await this.members.findById(subscription.memberId);
      if (!member) {
        // `subscription.member_id` is a foreign key; cannot happen without the
        // database edited by hand. Skip rather than fail the whole pass over one
        // impossible row.
        continue;
      }

      const token = mintWatchToken({
        subscriptionId: subscription.id,
        eventId: event.id,
        now: Date.now(),
        ttlMs: WATCH_TOKEN_TTL_MS,
        secret: this.config.streamTokenSecret,
      });

      try {
        await this.notifier.notify({
          toWhatsappNumber: member.whatsappNumber,
          message: buildLiveMessage({ eventTitle: event.title, watchUrl: this.watchUrl(token) }),
        });
        notified += 1;
      } catch (err) {
        // Collected, not thrown on the spot — see the class docstring for why
        // one member's provider failure must not stop the rest of the
        // community from being told. Never the watch link, never the token:
        // both are bearer credentials.
        failures.push(
          `member ${member.id} (subscription ${subscription.id}): ${redactLinks(safeErrorSummary(err))}`
        );
      }
    }

    await this.activityLog.record({
      memberId: null,
      communityId: event.communityId,
      eventType: STREAM_LIVE_NOTIFIED_EVENT,
      metadata: { eventId: event.id, notified, failed: failures.length },
    });

    if (failures.length > 0) {
      // The outbox row retries. See the class docstring for why a retry may
      // duplicate a message to a member already notified above.
      throw new Error(
        `notify_stream_live for event ${event.id} could not reach ${failures.length} ` +
          `member(s): ${failures.join("; ")}`
      );
    }

    return { notified };
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
      payload.eventId === ""
    ) {
      // Says what is wrong WITHOUT echoing the payload — same rule as
      // `grantAccessOutboxHandler`.
      throw new Error(
        "notify_stream_live outbox payload carries no usable string eventId " +
          "(the payload itself is deliberately not repeated here)"
      );
    }
    await useCase.execute({ eventId: payload.eventId });
  };
}

/**
 * The one message a member receives. In Indonesian, because members are — see
 * `buildMemberMessage` in `grant-channel-access.ts` for the same rule stated once.
 *
 * `watchUrl` is a single-use-audience, time-limited link (`WATCH_TOKEN_TTL_MS`,
 * six hours): said plainly, the same way `GrantChannelAccess`'s invite-link message
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
