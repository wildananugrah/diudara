import { NotFoundError } from "../errors";
import { newStreamKey, type StreamingProviderPort } from "../ports/streaming-provider.port";
import type { EventRecord, EventRepositoryPort } from "../ports/event-repository.port";

/**
 * What `POST /communities/:communityId/events` hands back — the ONLY place
 * `streamKey` and `rtmpUrl` ever appear together, because `rtmpUrl` is never
 * persisted (see `StreamingProviderPort`: it is pure URL construction from
 * the key and the adapter's own configuration, cheap to rebuild and
 * therefore not worth a column). A creator who loses this response has lost
 * the RTMP URL for good; the stream key itself survives on the `event` row
 * for `findByStreamKey` (Task 4), but nothing in this codebase reconstructs
 * `rtmpUrl` from it again after this call returns.
 */
export interface ScheduledSession {
  id: string;
  title: string;
  status: string;
  rtmpUrl: string;
  streamKey: string;
  hlsPlaybackPath: string;
}

/**
 * `POST /communities/:communityId/events` (design spec §4, step 1): a
 * creator schedules a session and gets back the RTMP URL and stream key
 * their encoder (OBS) needs.
 *
 * Mints the key EXACTLY ONCE, via `newStreamKey()` — see that function's
 * docstring for why it lives on the port module rather than on either
 * adapter — then asks whichever `StreamingProviderPort` bootstrap wired to
 * turn it into URLs, a call that is pure and cannot fail (see
 * `StreamingProviderPort`). Persistence and ownership both happen in the
 * SAME call, `EventRepositoryPort.createForCreator`: there is no separate
 * "does this creator own this community" check here, because the repository
 * IS the check (see that port's docstring) — a stranger's `communityId`
 * simply inserts nothing and returns `null`, which becomes a 404 here.
 *
 * `streamingProvider` is REQUIRED here, deliberately mirroring
 * `SendAiMessage`'s own constructor (which requires an `AiProviderPort`, not
 * `AiProviderPort | undefined`): whether the feature is configured at all is
 * a composition-root decision, not this class's — `bootstrap()` constructs
 * this use-case only when `streamingProvider` is defined, and leaves
 * `Dependencies.scheduleLiveSession` itself `undefined` otherwise (see
 * `selectStreamingProvider`). `routes/events.ts` checks THAT, the same shape
 * `POST /ai/messages` checks `sendAiMessage`, and answers 503 before this
 * class is ever reached — so nothing in here needs to reason about "not
 * configured" at all.
 */
export class ScheduleLiveSession {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly streamingProvider: StreamingProviderPort
  ) {}

  async execute(input: {
    creatorId: string;
    communityId: string;
    title: string;
    scheduledAt?: Date;
  }): Promise<ScheduledSession> {
    const streamKey = newStreamKey();
    const session = this.streamingProvider.createSession({ streamKey });

    const event = await this.events.createForCreator({
      communityId: input.communityId,
      creatorId: input.creatorId,
      title: input.title,
      scheduledAt: input.scheduledAt ?? null,
      streamKey,
      hlsPlaybackPath: session.hlsPlaybackPath,
    });
    if (!event) {
      throw new NotFoundError("community not found");
    }

    return {
      id: event.id,
      title: event.title,
      status: event.status,
      rtmpUrl: session.rtmpUrl,
      streamKey,
      hlsPlaybackPath: session.hlsPlaybackPath,
    };
  }
}

/**
 * `GET /communities/:communityId/events` — every session ever scheduled for
 * a community, for the creator who owns it.
 *
 * Deliberately NOT dependent on `StreamingProviderPort`: unlike scheduling,
 * listing rebuilds nothing and calls no provider, so it works exactly the
 * same whether streaming is configured on this box or not — a creator can
 * always see the sessions already on the calendar. `rtmpUrl` is absent from
 * every row here (see `ScheduledSession`'s docstring for why it is never
 * persisted); `streamKey` is present, because it is the creator's own secret
 * and this is still their own list.
 */
export class ListLiveSessions {
  constructor(private readonly events: EventRepositoryPort) {}

  async execute(input: { creatorId: string; communityId: string }): Promise<EventRecord[]> {
    const events = await this.events.listForCommunityForCreator(input.communityId, input.creatorId);
    if (!events) {
      throw new NotFoundError("community not found");
    }
    return events;
  }
}
