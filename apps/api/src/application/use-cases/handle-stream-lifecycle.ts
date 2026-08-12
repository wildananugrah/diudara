import { streamKeyFromPath } from "./authorise-stream";
import type { EventRepositoryPort } from "../ports/event-repository.port";
import { OUTBOX_NOTIFY_STREAM_LIVE } from "../ports/outbox-repository.port";
import type {
  StreamLifecycleRepositories,
  StreamLifecycleUnitOfWorkPort,
} from "../ports/stream-lifecycle-unit-of-work.port";

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
 * carried through a `curl -d` body the route parses (see `routes/mediamtx-webhooks.ts`).
 *
 * `$MTX_PATH` IS THE RUNTIME PATH, NOT THE BARE KEY. Confirmed against mediamtx.org's
 * hooks documentation ("MTX_PATH: path name") rather than assumed: under this
 * codebase's catch-all path config, a publish to `rtmp://<host>:1935/live/<key>` makes
 * `$MTX_PATH` equal `live/<key>` — the exact same shape `AuthoriseStream` parses out of
 * the auth webhook's `path` field. So `streamKeyFromPath` is REUSED here rather than
 * re-implemented: requiring the `live/` prefix (Task 4, review round 2) is what stops a
 * stray or malicious path this codebase's own adapter never constructs from marking an
 * event live whose members would then be sent an HLS URL that points nowhere.
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
 * row nor any `notify_stream_live` row is written on that path. That is what makes
 * "online twice" enqueue nothing a second time.
 * ==========================================================================
 *
 * ==========================================================================
 * THE TRANSITION AND EVERY NOTIFY INTENT COMMIT TOGETHER, OR NONE OF THEM DO
 *
 * `markLive`'s atomic predicate makes an event's transition to `live` a thing that can
 * happen AT MOST ONCE — a second `online` finds it already false. That means the
 * instant `status='live'` commits on its own, the one opportunity to queue a notify row
 * for this go-live is spent forever: no later hook will ever re-create it. So the audit
 * row and one `notify_stream_live` row per member entitled to hear about it are written
 * in the SAME `StreamLifecycleUnitOfWorkPort.run` call that performs the transition —
 * see that port's docstring for the failure this closes (a crash or a thrown error
 * between the UPDATE and an enqueue that used to happen afterwards, leaving the event
 * permanently `live` with nobody ever told). One outbox row PER MEMBER, not one row for
 * the whole community, for a second, independent reason: `ProcessOutbox`'s staleness
 * model sizes `touchProcessing` and its reclaim window around "one row is one or two
 * provider calls" — a single row fanning out to an unbounded roster can outlive that
 * window, and a second worker then reclaims and re-sends to the ENTIRE community
 * concurrently, which is exactly the double-claim `FOR UPDATE SKIP LOCKED` exists to
 * prevent. Per-member rows keep every row's cost bounded and let one bad send retry
 * without touching anybody else's — see `NotifyStreamLive`'s own docstring for what it
 * re-checks at delivery time regardless.
 * ==========================================================================
 *
 * AN UNKNOWN STREAM KEY, OR A `streamKey` THAT DOES NOT PARSE, IS A NORMAL, LOGGED,
 * SILENT-TO-THE-CALLER NO-OP — never a thrown error. MediaMTX retries a hook that gets
 * back anything other than success, and `runOnOnline`/`runOnOffline` are fire-and-forget
 * shell commands with no request context to blame; a 500 here would retry forever for a
 * key this table will never contain (a stale session, a probe, a race with the row not
 * yet committed). "Silent to the caller" is not "silent, full stop": both branches
 * `console.warn`, because failing closed AND mute turns a five-minute diagnosis into an
 * afternoon if `$MTX_PATH`'s shape ever turns out to differ from what this class
 * assumes. Neither log line echoes the raw `streamKey` value — see
 * `EventRepositoryPort`'s own docstring for why a stream key is a SECRET that must never
 * reach a log line, and a value that failed to parse as `live/<key>` may still, in the
 * unparsed case, BE the real secret (e.g. `$MTX_PATH` sent bare, with no prefix).
 *
 * ==========================================================================
 * THE STREAM-KEY LOOKUP HAPPENS OUTSIDE THE UNIT OF WORK — review round 2
 *
 * Mirrors `HandlePaymentWebhook`'s own split exactly: its steps 1-2 (find the
 * transaction, compare the amount) are reads against the POOLED repository, outside
 * `PaymentActivationUnitOfWorkPort.run`, and only once both hold does it open the unit
 * of work at all. `findByStreamKey` here follows the same rule and for the same reason
 * — "a lookup that fails should not open a transaction at all". Every probe, stale
 * session, or malformed path that does not resolve to a real event now never opens a
 * Postgres transaction; the unit of work opens only once there is a real event to act
 * on, and `markLive`/`markEnded`'s own atomic predicate — which still has to run INSIDE
 * it, because that is the only place "did this actually transition" can be decided
 * under concurrency — is what decides from there whether anything is written.
 * ==========================================================================
 */
export class HandleStreamLifecycle {
  constructor(
    /**
     * The POOLED repository, used ONLY for the lookup below — never for a write, and
     * never passed into `unitOfWork.run`. See the class docstring's third banner for
     * why this read stays outside any transaction.
     */
    private readonly events: EventRepositoryPort,
    private readonly unitOfWork: StreamLifecycleUnitOfWorkPort
  ) {}

  async execute(input: { hook: StreamLifecycleHook; streamKey: string }): Promise<void> {
    const key = streamKeyFromPath(input.streamKey);
    if (key === "") {
      // NEVER log `input.streamKey` itself here — see the class docstring. It may be
      // the real secret, sent in a shape this class does not recognise.
      console.warn(
        `[lifecycle] ignoring a "${input.hook}" hook: streamKey did not parse as ` +
          '"live/<key>" (see streamKeyFromPath in authorise-stream.ts) — if this is not ' +
          "a one-off, check infra/mediamtx.yml's path configuration and $MTX_PATH's " +
          "actual runtime shape, since every event will otherwise silently stay " +
          "scheduled/live forever"
      );
      return;
    }

    // OUTSIDE the unit of work — see the class docstring's third banner. A malformed
    // path never reaches here at all (returned above); this is the "does the key
    // resolve to a real event" gate for everything else that doesn't.
    const event = await this.events.findByStreamKey(key);
    if (!event) {
      // Unknown key. See the class docstring for why this logs and returns quietly
      // rather than throwing — and why the key itself is never in the message.
      console.warn(
        `[lifecycle] ignoring a "${input.hook}" hook: no event matches this stream key`
      );
      return;
    }

    await this.unitOfWork.run(async (repositories) => {
      if (input.hook === "online") {
        await this.handleOnline(repositories, event.id);
        return;
      }
      await this.handleOffline(repositories, event.id);
    });
  }

  private async handleOnline(
    repositories: StreamLifecycleRepositories,
    eventId: string
  ): Promise<void> {
    const updated = await repositories.events.markLive(eventId);
    if (!updated) {
      // `markLive` refused: the event was already `live` (a repeated `online`) or
      // already `ended` (a late `online` MUST NOT resurrect it). Either way,
      // nothing transitioned, so nothing is recorded and nobody is notified a
      // second time.
      return;
    }

    await repositories.activityLog.record({
      memberId: null,
      communityId: updated.communityId,
      eventType: STREAM_LIVE_EVENT,
      metadata: { eventId: updated.id },
    });

    // The roster AT GO-LIVE TIME, resolved inside this same transaction. It is not
    // the last word on who gets messaged — `NotifyStreamLive` re-checks entitlement
    // fresh, per row, at delivery time (a member can still churn in between) — but it
    // is the ONE moment this class enqueues anything, which is why it has to commit
    // atomically with the transition above. See the class docstring's second banner.
    const activeSubscriptions = await repositories.subscriptions.listActiveForCommunity(
      updated.communityId
    );
    if (activeSubscriptions.length === 0) {
      return;
    }

    // ONE multi-row INSERT, not one round trip per member — review round 2. Each
    // `await` in a loop is a serial round trip held open while this transaction
    // holds the `events` row lock `markLive` took and one of postgres.js's ten pool
    // connections, with MediaMTX's fire-and-forget `curl` waiting on the response
    // the whole time. An N-member community turned that into N round trips before
    // the webhook could answer; `enqueueMany` turns it back into one, without
    // touching the atomicity this transaction exists for — every row is still
    // written inside it, still all-or-nothing with the transition above.
    await repositories.outbox.enqueueMany(
      activeSubscriptions.map((subscription) => ({
        eventType: OUTBOX_NOTIFY_STREAM_LIVE,
        // Ids only — no member list beyond this one id, no community id, no stream
        // key. `NotifyStreamLive` re-resolves everything else fresh, at delivery
        // time, from `eventId` and `subscriptionId` alone.
        payload: { eventId: updated.id, subscriptionId: subscription.id },
      }))
    );
  }

  private async handleOffline(
    repositories: StreamLifecycleRepositories,
    eventId: string
  ): Promise<void> {
    const updated = await repositories.events.markEnded(eventId);
    if (!updated) {
      // Already `ended` — a flapping publisher's repeated `offline`. No-op.
      return;
    }

    await repositories.activityLog.record({
      memberId: null,
      communityId: updated.communityId,
      eventType: STREAM_ENDED_EVENT,
      metadata: { eventId: updated.id },
    });
  }
}
