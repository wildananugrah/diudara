import { streamKeyFromPath } from "./authorise-stream";
import type { ActivityLogRepositoryPort } from "../ports/activity-log-repository.port";
import type { EventRepositoryPort } from "../ports/event-repository.port";
import { OUTBOX_NOTIFY_STREAM_LIVE, type OutboxRepositoryPort } from "../ports/outbox-repository.port";

/** `activity_log.event_type` written the moment an event transitions to `live`. */
export const STREAM_LIVE_EVENT = "stream_live";

/** `activity_log.event_type` written the moment an event transitions to `ended`. */
export const STREAM_ENDED_EVENT = "stream_ended";

/** The two lifecycle edges MediaMTX's hooks report. See this class's docstring. */
export type StreamLifecycleHook = "online" | "offline";

/**
 * `POST /webhooks/mediamtx/lifecycle`'s decision logic — the other half of Task 4's
 * publish/read authorisation. Where `AuthoriseStream` decides whether a publish or a
 * read may happen, this class reacts to MediaMTX telling us one already did (or
 * stopped): `runOnOnline` when a publisher starts, `runOnOffline` when it stops. Per
 * the design spec's own correction of the MVP spec (§2), these are the real hook
 * names — there is no `runOnPublish`/`runOnUnpublish` — and they are SHELL COMMANDS
 * MediaMTX runs, not requests it POSTs, so `streamKey` here is `$MTX_PATH` verbatim,
 * carried through a `curl -d` body the route parses (see
 * `routes/mediamtx-webhooks.ts`).
 *
 * `$MTX_PATH` IS THE RUNTIME PATH, NOT THE BARE KEY. Confirmed against
 * mediamtx.org's hooks documentation ("MTX_PATH: path name") rather than assumed:
 * under this codebase's catch-all path config, a publish to
 * `rtmp://<host>:1935/live/<key>` makes `$MTX_PATH` equal `live/<key>` — the exact
 * same shape `AuthoriseStream` parses out of the auth webhook's `path` field. So
 * `streamKeyFromPath` is REUSED here rather than re-implemented: requiring the
 * `live/` prefix (Task 4, review round 2) is what stops a stray or malicious path
 * this codebase's own adapter never constructs from marking an event live whose
 * members would then be sent an HLS URL that points nowhere.
 *
 * ==========================================================================
 * OUT-OF-ORDER AND REPEATED HOOKS ARE THE NORMAL CASE, NOT AN EDGE CASE
 *
 * MediaMTX can fire `runOnOffline` for a session the API never saw go `online` (the
 * API restarted mid-stream, or missed the delivery), and a flapping publisher fires
 * either hook repeatedly. Every transition here must therefore be IDEMPOTENT, and an
 * event must never move BACKWARDS — a late `online` arriving after `offline` has
 * already fired must not resurrect an `ended` event.
 *
 * This class does not implement that guarantee itself. It DELEGATES it to
 * `EventRepositoryPort.markLive`/`markEnded`, whose status check is part of the
 * UPDATE's own predicate rather than a preceding read — see that port's docstring.
 * `execute` below only ever acts on what those calls report actually changed: a
 * `null` return means "nothing to do", not an error, and neither the `activity_log`
 * row nor the `notify_stream_live` outbox row is written on that path. That is what
 * makes "online twice" enqueue exactly one outbox row rather than one per delivery.
 * ==========================================================================
 *
 * AN UNKNOWN STREAM KEY IS A NORMAL, SILENT NO-OP — never a thrown error. MediaMTX
 * retries a hook that gets back anything other than success, and `runOnOnline`/
 * `runOnOffline` are fire-and-forget shell commands with no request context to
 * blame; a 500 here would retry forever for a key this table will never contain
 * (a stale session, a probe, a race with the row not yet committed). The route
 * that calls this always answers 200 once the shared secret has checked out — see
 * `routes/mediamtx-webhooks.ts`.
 */
export class HandleStreamLifecycle {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly activityLog: ActivityLogRepositoryPort,
    /**
     * `notify_stream_live` is enqueued here, never sent inline: a WhatsApp send is
     * an external HTTP call per member, and a provider outage must delay the
     * notification, never the API's response to MediaMTX (plan, Global
     * Constraints). See `notify-stream-live.ts` for the consumer.
     */
    private readonly outbox: OutboxRepositoryPort
  ) {}

  async execute(input: { hook: StreamLifecycleHook; streamKey: string; now: number }): Promise<void> {
    const key = streamKeyFromPath(input.streamKey);
    if (key === "") {
      // Not `live/<key>` shaped at all — MediaMTX's own catch-all config never
      // produces anything else, so this is either a misconfiguration or a hook
      // this codebase never wired. Same silent no-op as an unresolved key below:
      // there is nothing here worth a database write over.
      return;
    }

    const event = await this.events.findByStreamKey(key);
    if (!event) {
      // Unknown key. See the class docstring for why this returns quietly
      // rather than throwing.
      return;
    }

    if (input.hook === "online") {
      await this.handleOnline(event.id);
      return;
    }
    await this.handleOffline(event.id);
  }

  private async handleOnline(eventId: string): Promise<void> {
    const updated = await this.events.markLive(eventId);
    if (!updated) {
      // `markLive` refused: the event was already `live` (a repeated `online`) or
      // already `ended` (a late `online` MUST NOT resurrect it). Either way,
      // nothing transitioned, so nothing is recorded and nobody is notified a
      // second time.
      return;
    }

    await this.activityLog.record({
      memberId: null,
      communityId: updated.communityId,
      eventType: STREAM_LIVE_EVENT,
      metadata: { eventId: updated.id },
    });

    await this.outbox.enqueue({
      eventType: OUTBOX_NOTIFY_STREAM_LIVE,
      // Ids only — no member list, no community id, no stream key. Never the
      // stream key: it is a bearer credential (see `EventRepositoryPort`'s
      // docstring) and an outbox row is read by the worker's log lines on
      // failure. `NotifyStreamLive` re-resolves everything else fresh, at
      // delivery time, from `eventId` alone — see that class's docstring for
      // why that re-resolution is the whole point.
      payload: { eventId: updated.id },
    });
  }

  private async handleOffline(eventId: string): Promise<void> {
    const updated = await this.events.markEnded(eventId);
    if (!updated) {
      // Already `ended` — a flapping publisher's repeated `offline`. No-op.
      return;
    }

    await this.activityLog.record({
      memberId: null,
      communityId: updated.communityId,
      eventType: STREAM_ENDED_EVENT,
      metadata: { eventId: updated.id },
    });
  }
}
