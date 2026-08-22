import { ForbiddenError, NotFoundError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import { newStreamKey, type StreamingProviderPort } from "../ports/streaming-provider.port";
import type {
  UserStreamRepositoryPort,
  UserStreamRow,
} from "../ports/user-stream-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import { MEMBERS_ONLY } from "./post-views";
import { toStreamView, userStreamPlaybackPath, type StreamView } from "./stream-views";

/** "this stream is not yours" — the DELETE refusal, Bahasa like every other 403 a person can hit. */
const NOT_YOURS_MESSAGE = "siaran ini bukan milik Anda";

/**
 * What `POST /streams` hands back, and the ONLY response in this codebase's
 * new world that carries `streamKey` at all.
 *
 * The creator needs it: `rtmpUrl` plus the key is what they paste into OBS,
 * and `whipUrl` is what their browser publishes to (Task 7). Neither URL is
 * persisted — both are pure construction from the key and the adapter's
 * configuration (see `StreamingProviderPort`) — so a creator who loses this
 * response has lost them until they start another stream. That is the same
 * bargain `ScheduledSession` makes in the old world.
 *
 * `hlsPlaybackPath` is deliberately NOT `createSession`'s: it is the same
 * public, id-derived path `GET /streams` publishes (`userStreamPlaybackPath`).
 * One stream has ONE watchable path, and the creator watching their own
 * broadcast back must be looking at the very URL their audience is — the
 * alternative is a preview that works only for the person who cannot tell
 * whether it works for anybody else. `createSession`'s own `hlsPlaybackPath`
 * carries the stream key in the URL and is discarded here for exactly the
 * reason `userStreamPlaybackPath`'s docstring gives.
 */
export interface StartedUserStream {
  id: string;
  title: string;
  visibility: string;
  rtmpUrl: string;
  whipUrl: string;
  streamKey: string;
  hlsPlaybackPath: string;
}

/**
 * `POST /streams` (design spec §7): *Mulai siaran*. Mints a key, asks the
 * provider for the publish URLs, and inserts one `live` row.
 *
 * **THE DOUBLE-TAP IS ARBITRATED BY THE DATABASE, NOT BY A CHECK HERE.**
 * There is deliberately no "does this person already have a live stream"
 * read before the insert. `UserStreamRepositoryPort.startLive` is a bare
 * INSERT and `user_stream_one_live` — the partial unique index on
 * `(owner_id) WHERE status = 'live'` — is what refuses the loser, as a
 * `UniqueViolationError`. That error already extends `ConflictError`, so it
 * reaches the client as a 409 with the repository's Bahasa sentence
 * unchanged and nothing here has to catch it.
 *
 * A read-then-write pre-check would look identical in every sequential test
 * and lose under concurrency, which Phase 5a established three separate
 * times. `start-user-stream.test.ts`'s thirty-contender race is what proves
 * this implementation is not that one; it is not decoration.
 *
 * `streamingProvider` is REQUIRED, mirroring `ScheduleLiveSession`'s own
 * constructor exactly: whether streaming is configured at all is a
 * composition-root decision. `bootstrap()` constructs this class only when
 * `Dependencies.streamingProvider` is defined and leaves
 * `Dependencies.startUserStream` `undefined` otherwise, and `routes/streams.ts`
 * answers 503 off THAT — so nothing in here reasons about "not configured".
 */
export class StartUserStream {
  constructor(
    private readonly streams: UserStreamRepositoryPort,
    private readonly streamingProvider: StreamingProviderPort
  ) {}

  async execute(input: {
    ownerId: string;
    title: string;
    visibility: string;
  }): Promise<StartedUserStream> {
    const streamKey = newStreamKey();
    // `namespace: "u"` (Task 4) — the whole reason this parameter exists.
    // Without it this line built `live/<key>`, so a creator publishing to the
    // url this use case hands back reached `AuthoriseStream` as the COMMUNITY
    // world and was looked up in the `event` table. See
    // `StreamingProviderPort.createSession`'s own docstring.
    const session = this.streamingProvider.createSession({ streamKey, namespace: "u" });

    const stream = await this.streams.startLive({
      ownerId: input.ownerId,
      title: input.title,
      visibility: input.visibility,
      streamKey,
    });

    // Field by field, never a spread of `stream` — that row carries
    // `ownerId`, `status`, `startedAt` and `endedAt` too, none of which this
    // response promises.
    return {
      id: stream.id,
      title: stream.title,
      visibility: stream.visibility,
      rtmpUrl: session.rtmpUrl,
      whipUrl: session.whipUrl,
      streamKey,
      hlsPlaybackPath: userStreamPlaybackPath(stream.id),
    };
  }
}

/**
 * `GET /streams` (design spec §8): who is live, newest first, visible to
 * everyone — signed in or not.
 *
 * **THE GATE, batched for the page** the way Phase 6 batches a feed's
 * authors. A stream is LOCKED when `visibility = 'members'` and the viewer is
 * neither its owner nor a currently-paying member of that owner. The set
 * starts as every gated owner on the page and memberships are REMOVED from
 * it, so a bug here — a missing row, a query that answers nothing — fails
 * toward locked, never toward open.
 *
 * ONE query for the whole listing, not one per row: `listActiveOwnersAmong`
 * is `is-member-of.ts`'s definition ("`status = 'active'` AND
 * `current_period_end > now`", strict) answered for many owners at once, and
 * its own docstring says so. `IsMemberOf` itself is deliberately NOT called
 * here — it is a per-pair question and this is a page — and it is not edited
 * either; the two agree by construction because the repository method mirrors
 * `membershipStanding`, which is the arrangement Phase 5b shipped and Phase 6
 * already relies on for the feed.
 *
 * A signed-out viewer (`viewerId === null`) skips the query entirely: there
 * is no subscriber id to ask about, and the only answer such a query could
 * have is the one the set already holds.
 *
 * **NO STREAMING PROVIDER IS NEEDED, and that is load-bearing.** This class
 * reads rows and derives a same-origin playback path from each row's id
 * (`userStreamPlaybackPath`). `bootstrap()` therefore constructs it
 * unconditionally — unlike `StartUserStream` above — because a listing that
 * 503s over a writer's dependency would take Siaran down for every reader on
 * a box where nobody configured MediaMTX.
 */
export class ListLiveStreams {
  constructor(
    private readonly streams: UserStreamRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { viewerId: string | null }): Promise<{ streams: StreamView[] }> {
    const rows = await this.streams.listLive();
    // Read the clock ONCE for the whole page and pass the instant down —
    // Phase 5b shipped a residual defect caused by a use case reading
    // `clock.now()` twice around a query, answering a membership whose period
    // ended between the two reads inconsistently.
    const now = this.clock.now();
    // The owner of a gated stream is never locked out of it and is never
    // asked about either: nobody subscribes to themselves, so the query would
    // be a round trip whose answer cannot be yes.
    const gated = rows.filter(
      (row) => row.visibility === MEMBERS_ONLY && row.ownerId !== input.viewerId
    );
    const lockedOwners = new Set(gated.map((row) => row.ownerId));
    if (input.viewerId !== null && lockedOwners.size > 0) {
      for (const ownerId of await this.subscriptions.listActiveOwnersAmong(
        input.viewerId,
        [...lockedOwners],
        now
      )) {
        lockedOwners.delete(ownerId);
      }
    }
    // Narrowed back to STREAMS before it is consulted, so the lock is asked
    // about the row rather than about its owner. `toFeedPage` keeps an
    // owner-shaped set and re-checks `visibility` at every row instead — a
    // post's author can hold a gated and a public post on the same page, and
    // locking on membership alone there would withhold the public one. Here
    // that second check would be UNREACHABLE: `user_stream_one_live` means an
    // owner has at most one live row, so an owner in `lockedOwners` is in it
    // because of the very row being projected. An unreachable guard is worse
    // than none — nothing can prove it still works — so the gate's two
    // conditions (`visibility`, and "not your own") stay in exactly one place,
    // the `gated` filter above, and this set carries the answer.
    const lockedStreamIds = new Set(
      gated.filter((row) => lockedOwners.has(row.ownerId)).map((row) => row.id)
    );
    return { streams: rows.map((row) => toStreamView(row, lockedStreamIds.has(row.id))) };
  }
}

/**
 * `DELETE /streams/:id` (design spec §7): a creator ends their OWN broadcast.
 *
 * The two other ways a row leaves `live` — MediaMTX's lifecycle webhook and
 * the hourly stale sweep — are Task 5's, and all three land on the same
 * `endById`, whose `status = 'live'` predicate is IN the UPDATE rather than
 * read first. That is what makes this safe against the webhook arriving for
 * the same row at the same moment.
 *
 * IDEMPOTENT: ending an already-ended stream answers normally rather than
 * 404ing. The same ruling `DeletePost` made — "a button that errors when the
 * state already matches what you asked for is worse than one that agrees" —
 * and here it also covers the ordinary case of the webhook having won the
 * race a few milliseconds earlier.
 *
 * Ownership is checked HERE rather than pushed into the repository, because
 * `endById` is deliberately unscoped: the webhook and the sweep both call it
 * with no authenticated owner in the picture (see the port's docstring). An
 * unknown id is an English `NotFoundError`; somebody else's stream is a
 * Bahasa 403, the same split `DeletePost` uses. The 403 rather than a 404
 * matches that precedent: a live stream is already listed publicly by
 * `GET /streams`, so its existence is not a secret this refusal could keep.
 */
export class EndOwnUserStream {
  constructor(
    private readonly streams: UserStreamRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { ownerId: string; streamId: string }): Promise<void> {
    const stream: UserStreamRow | null = await this.streams.findById(input.streamId);
    if (stream === null) throw new NotFoundError("stream not found");
    if (stream.ownerId !== input.ownerId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    await this.streams.endById(input.streamId, this.clock.now());
  }
}
