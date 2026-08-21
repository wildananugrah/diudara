import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { JoinRequestRepositoryPort } from "../ports/join-request-repository.port";
import type { MessagingProviderPort } from "../ports/messaging-provider.port";

/**
 * `activity_log.event_type` for a request whose owner could not be reached —
 * `NotifyJoinRequest`'s counterpart to `GrantChannelAccess`'s
 * `access_manual_required`: automation could not finish, recorded rather than
 * silently dropped.
 */
export const JOIN_REQUEST_NOTIFY_SKIPPED_EVENT = "join_request_notify_skipped";

/**
 * `skippedReason`/`activity_log.metadata.reason` for the crux case this class
 * exists to handle: the owner has no WhatsApp number anywhere, and would
 * otherwise turn every single join request into a permanently failing outbox
 * row.
 *
 * The VALUE is deliberately unchanged by Task 7 even though the number is no
 * longer read from `creator` alone (see `findNotificationContext`): it is
 * already written into `activity_log` rows in the field, and renaming it would
 * split the history of one situation across two strings for no gain.
 */
export const CREATOR_WHATSAPP_MISSING_REASON = "creator_whatsapp_missing";

/**
 * `skippedReason` for a row whose `joinRequestId` no longer resolves to a
 * request with a live community, creator, member AND tier —
 * `findNotificationContext` collapses all four possible misses into this one
 * case, since none of them is fixable by a retry. See that method's own
 * docstring.
 */
export const JOIN_REQUEST_CONTEXT_MISSING_REASON = "join_request_context_missing";

export interface NotifyJoinRequestInput {
  joinRequestId: string;
}

export interface NotifyJoinRequestResult {
  /** Whether the owner actually received a WhatsApp message. */
  notified: boolean;
  /** Set when nothing was sent, saying why. */
  skippedReason?: string;
}

/**
 * The consumer of `RequestToJoin`'s `notify_join_request` outbox row: a member
 * asked to join a free community, and the owner gets a WhatsApp message telling
 * them so.
 *
 * ONE message to ONE person — the community's creator — never the member, and
 * never a group. The payload carries `joinRequestId` only; everything else
 * (community name, member name, tier name, the owner's own WhatsApp number)
 * is re-resolved FRESH at delivery time via `findNotificationContext`, the same
 * reason `NotifyStreamLive`'s payload carries ids and not a snapshot: a row can
 * sit queued long enough for the community's name or the creator's own number
 * to have changed underneath it.
 *
 * ==========================================================================
 * TWO WAYS THIS ROW CAN NEVER SUCCEED, BOTH CONSUMED RATHER THAN RETRIED
 *
 * 1. THE CONTEXT NO LONGER RESOLVES. `findNotificationContext` INNER JOINs the
 *    join request through its community, the community's creator, its member
 *    and its tier — none of those has a delete path in this codebase today, so
 *    a genuine miss should not happen, but if it ever does, retrying changes
 *    nothing: there is nobody left to notify and nothing left to notify them
 *    about. Unlike `NotifyStreamLive`'s throw on a similarly "impossible" miss
 *    (which exists because that class's ids are freshly written moments
 *    earlier by the SAME transaction, so a miss there really would mean a
 *    bug), this row can be enqueued and then sit for a while before delivery,
 *    so a miss is treated as "nothing to do" rather than alarmed on.
 *
 * 2. THE OWNER HAS NO WHATSAPP NUMBER ON FILE ANYWHERE. Both columns
 *    `findNotificationContext` reads are nullable — their `app_user` account's
 *    (the one this application lets them edit, preferred) and their `creator`
 *    row's (the fallback) — and an owner can sign up and set neither, so there
 *    is no number to retry against tomorrow that was not there today. Treated
 *    exactly the way `GrantChannelAccess` treats a platform it cannot gate
 *    automatically: recorded in `activity_log` and moved on, never thrown.
 *    Task 7's pending-requests dashboard is the real fallback for this case,
 *    which is why this is not a loud failure — the owner can still see and act
 *    on the request without ever having received a message about it.
 *
 * Both are told apart from a TRANSIENT failure (the messaging provider being
 * down), which must still throw so the outbox retries it: only a row that can
 * never succeed is consumed here.
 * ==========================================================================
 */
export class NotifyJoinRequest {
  constructor(
    private readonly joinRequests: JoinRequestRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    /**
     * How the OWNER is reached: WhatsApp, always. Separate from any gating
     * provider for the same reason every other notifier in this codebase is —
     * `TelegramBotAdapter.notify` throws, since it addresses a WhatsApp number
     * it has no way to reach.
     */
    private readonly notifier: MessagingProviderPort
  ) {}

  async execute(input: NotifyJoinRequestInput): Promise<NotifyJoinRequestResult> {
    const context = await this.joinRequests.findNotificationContext(input.joinRequestId);
    if (!context) {
      // See the class docstring, point 1. No `communityId` survives a miss this
      // deep in the join, so there is nothing valid to write an `activity_log`
      // row against — a console warning is what an operator has to go on.
      console.warn(
        `[join-request] notify_join_request consumed with nothing to send: request=` +
          `${input.joinRequestId} no longer resolves to a request with a live ` +
          "community, creator, member and tier. Nothing here is fixable by a retry."
      );
      return { notified: false, skippedReason: JOIN_REQUEST_CONTEXT_MISSING_REASON };
    }

    if (context.creatorWhatsappNumber === null) {
      // See the class docstring, point 2 — the crux case this class exists for.
      await this.activityLog.record({
        memberId: context.memberId,
        communityId: context.communityId,
        eventType: JOIN_REQUEST_NOTIFY_SKIPPED_EVENT,
        metadata: { joinRequestId: context.id, reason: CREATOR_WHATSAPP_MISSING_REASON },
      });
      return { notified: false, skippedReason: CREATOR_WHATSAPP_MISSING_REASON };
    }

    // Not written before this line: a send that throws must retry from a clean
    // slate, and writing a message-sent-equivalent record here first would
    // have nothing to undo it — same rule `NotifyStreamLive` states for its own
    // `activityLog.record` call after `notify`.
    await this.notifier.notify({
      toWhatsappNumber: context.creatorWhatsappNumber,
      message: buildOwnerMessage({
        communityName: context.communityName,
        memberName: context.memberName,
        tierName: context.tierName,
      }),
    });

    return { notified: true };
  }
}

/**
 * Adapts the use-case to `ProcessOutbox`'s handler signature, and is the ONE
 * place the `notify_join_request` payload contract is checked — same shape
 * and reasoning as `notifyStreamLiveOutboxHandler`.
 */
export function notifyJoinRequestOutboxHandler(useCase: NotifyJoinRequest) {
  return async (payload: unknown): Promise<void> => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("joinRequestId" in payload) ||
      typeof payload.joinRequestId !== "string" ||
      payload.joinRequestId === ""
    ) {
      // Says what is wrong WITHOUT echoing the payload — same rule as
      // `notifyStreamLiveOutboxHandler`.
      throw new Error(
        "notify_join_request outbox payload carries no usable string joinRequestId " +
          "(the payload itself is deliberately not repeated here)"
      );
    }
    await useCase.execute({ joinRequestId: payload.joinRequestId });
  };
}

/**
 * The one message the OWNER receives. In Indonesian, because creators are —
 * same rule stated once in `grant-channel-access.ts`'s `buildMemberMessage`.
 *
 * `memberName ?? "Seseorang"` rather than the empty string: `member.name` is
 * nullable (a WhatsApp-only signup may have none), and `PendingJoinRequestRow`
 * / `JoinRequestNotificationContext` both deliberately report that `null`
 * rather than coalescing it away — see either docstring. Coalescing to `''`
 * HERE instead would read "... Kelas Rina:  ingin bergabung ..." — a broken
 * sentence with a doubled space, sent over WhatsApp, with no error anywhere.
 *
 * Never the member's WhatsApp number: it adds nothing the dashboard does not
 * already show, and it would put a second person's number into a third-party
 * messaging provider's logs.
 */
function buildOwnerMessage(input: {
  communityName: string;
  memberName: string | null;
  tierName: string;
}): string {
  const memberName = input.memberName ?? "Seseorang";
  return (
    `Permintaan bergabung baru di ${input.communityName}: ${memberName} ingin bergabung ` +
    `ke tier ${input.tierName}. Setujui atau tolak di dasbor DIUDARA.`
  );
}
