import { NotFoundError } from "../errors";
import { newStreamKey, type StreamingProviderPort } from "../ports/streaming-provider.port";
import type { EventRecord, EventRepositoryPort } from "../ports/event-repository.port";

/**
 * What `POST /communities/:communityId/events` hands back — the ONLY place
 * `streamKey`, `rtmpUrl` and (Task 2) `whipUrl` ever appear together, because
 * neither URL is persisted (see `StreamingProviderPort`: both are pure URL
 * construction from the key and the adapter's own configuration, cheap to
 * rebuild and therefore not worth a column). A creator who loses this
 * response has lost the RTMP and WHIP URLs for good; the stream key itself
 * survives on the `event` row for `findByStreamKey` (Task 4), but nothing in
 * this codebase reconstructs either URL from it again after this call
 * returns.
 *
 * `whipUrl` carries the stream key exactly as `rtmpUrl` does, so it is
 * exactly as sensitive — see this class's own docstring below for the
 * owner-scoping that keeps it away from a stranger and, by extension, from a
 * member.
 */
export interface ScheduledSession {
  id: string;
  title: string;
  status: string;
  rtmpUrl: string;
  whipUrl: string;
  streamKey: string;
  hlsPlaybackPath: string;
}

/**
 * `POST /communities/:communityId/events` (design spec §4, step 1): a
 * creator schedules a session and gets back the RTMP URL, the WHIP URL
 * (Task 2 — a browser publish target Task 3's UI uses as an alternative to
 * OBS), and the stream key both depend on.
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
      whipUrl: session.whipUrl,
      streamKey,
      hlsPlaybackPath: session.hlsPlaybackPath,
    };
  }
}

/**
 * `EventRecord` plus the two URLs rebuilt for it, when they can be — see
 * `ListLiveSessions`'s own docstring for when that is and is not possible.
 */
export interface ListedLiveSession extends EventRecord {
  rtmpUrl: string | null;
  whipUrl: string | null;
}

/**
 * `GET /communities/:communityId/events` — every session ever scheduled for
 * a community, for the creator who owns it.
 *
 * REBUILDS `rtmpUrl` and `whipUrl` from the persisted `streamKey` (Task 2
 * review, Important #3 — fixed after `whipUrl` shipped existing only in
 * `ScheduleLiveSession`'s own response). Before this fix, a "go live from
 * the browser" button had no publish target for any session other than the
 * one just created in the current page load: `whipUrl` is never persisted
 * (see `ScheduledSession`'s docstring — it is cheap to rebuild and not worth
 * a column), and nothing rebuilt it again after the POST response. For RTMP
 * that was survivable — a creator pastes the URL into OBS once, at schedule
 * time — but it is NOT survivable for browser publishing, where the publish
 * UI itself lives on this listing page. `StreamingProviderPort.createSession`
 * is pure and synchronous (see that port's docstring), so rebuilding here
 * costs nothing a persisted column would have saved.
 *
 * `streamingProvider` is OPTIONAL, unlike `ScheduleLiveSession`'s own
 * (required) constructor param — deliberately: listing must keep working
 * when streaming is disabled on this box (`bootstrap()` passes `undefined`
 * exactly when `Dependencies.streamingProvider` is), so a creator can still
 * see the sessions already on the calendar. When there is no provider to ask
 * — or a row's `streamKey` is itself `null`, which none created through
 * `ScheduleLiveSession` ever is, but the column allows it — both URLs come
 * back `null` rather than being omitted, so a caller always sees the same
 * two keys.
 *
 * `streamKey` itself is still present on every row, exactly as before this
 * fix: it is the creator's own secret, and this is still their own list. No
 * new exposure — `whipUrl` carries the same key `streamKey` already did.
 */
export class ListLiveSessions {
  constructor(
    private readonly events: EventRepositoryPort,
    private readonly streamingProvider?: StreamingProviderPort
  ) {}

  async execute(input: {
    creatorId: string;
    communityId: string;
  }): Promise<ListedLiveSession[]> {
    const events = await this.events.listForCommunityForCreator(input.communityId, input.creatorId);
    if (!events) {
      throw new NotFoundError("community not found");
    }
    return events.map((event) => {
      if (!event.streamKey || !this.streamingProvider) {
        return { ...event, rtmpUrl: null, whipUrl: null };
      }
      const session = this.streamingProvider.createSession({ streamKey: event.streamKey });
      return { ...event, rtmpUrl: session.rtmpUrl, whipUrl: session.whipUrl };
    });
  }
}
