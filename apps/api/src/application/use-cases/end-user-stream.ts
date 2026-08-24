import type { ClockPort } from "../ports/clock.port";
import type { UserStreamRepositoryPort } from "../ports/user-stream-repository.port";

/** The two lifecycle edges MediaMTX's hooks report (`runOnOnline`/`runOnOffline`). */
export type UserStreamLifecycleHook = "online" | "offline";

/**
 * `POST /webhooks/mediamtx/lifecycle`'s decision logic for the `u/<key>` world, and
 * — since retire-telegram Task 3 deleted the community `live/<key>` world's own
 * handler — the ONLY decision logic that route has left.
 *
 * IT WAS ALWAYS A SEPARATE CLASS, never a branch inside the community one, and the
 * reason is worth keeping now that the sibling is gone: the two worlds' `online`
 * hooks did genuinely different things. The community world's `online` transitioned
 * a `scheduled` event to `live` — real domain work with a real "first time" to
 * guard. The user world has none of that: `user_stream` is already `live` the
 * INSTANT `StartUserStream.execute` inserts the row (design spec §7, *"Mulai siaran
 * creates the row"*) — there is no `scheduled` state, and therefore no transition
 * left for `online` to make. That asymmetry is what the "online" no-op below rests
 * on, and it is a fact about `user_stream`, not about the class that used to sit
 * beside this one.
 *
 * `POST /webhooks/mediamtx/lifecycle` (the route) still parses `$MTX_PATH` with
 * `parseStreamPath` ONCE, itself, before reaching this class — and now REFUSES with
 * a 404 when the path names anything other than the user world, rather than handing
 * it to a second class. See that route's own docstring. This class therefore takes
 * the BARE key (`parsed.key`), never the raw `u/<key>` path.
 *
 * ==========================================================================
 * "online" IS A DELIBERATE NO-OP, and that is the guard that matters most here
 *
 * A late `online` — MediaMTX retrying a fire-and-forget hook, or a takeover publish
 * racing the row's own end (`infra/mediamtx.yml`'s `overridePublisher: false` makes
 * that specific race refuse rather than take over, but nothing stops a genuinely late
 * duplicate) — must never resurrect a row `offline` or the hourly sweep
 * (`apps/worker/src/scheduled-passes.ts`'s `SweepStaleUserStreams`) has already ended.
 * Since there is no "mark live" transition for `online` to perform, the safest
 * implementation of "do nothing that could resurrect anything" is to do NOTHING AT
 * ALL: no repository call, no lookup, no branch that could later grow a write. The
 * `offline` branch below is the only place this class ever touches the database.
 * ==========================================================================
 *
 * AN UNKNOWN STREAM KEY IS A NORMAL, LOGGED, SILENT-TO-THE-CALLER NO-OP: a stale
 * session, a probe, or a race with the row not yet committed must not make MediaMTX
 * retry forever, and the key itself is NEVER logged (it is `user_stream.stream_key`,
 * a SECRET — see `UserStreamRepositoryPort`'s own docstring).
 *
 * NOTE THE ASYMMETRY WITH THE ROUTE'S OWN 404: an unknown `u/<key>` is acknowledged
 * with a 200, while a `live/<key>` is refused. Those are different statements. The
 * first says "this key names no live row right now", which is ordinary and expected;
 * the second says "this server has no namespace by that name", which is a
 * misconfiguration nothing else would surface.
 *
 * `endById`'s status check is IN the UPDATE's predicate, not a preceding read (see
 * that port's docstring). That atomic-predicate shape is what makes the `offline`
 * branch safe under a flapping publisher (repeated `offline`) or a race
 * with the hourly sweep ending the same row first. A repeat or a raced `offline` finds
 * `endById` return `null` and this method simply returns — nothing further to do,
 * nothing to log, no error.
 */
export class EndUserStream {
  constructor(
    private readonly streams: UserStreamRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  async execute(input: { hook: UserStreamLifecycleHook; streamKey: string }): Promise<void> {
    if (input.hook === "online") {
      // See the class docstring's banner. Nothing to transition, and touching the row
      // at all here is exactly the shape a resurrection bug would take.
      return;
    }

    const stream = await this.streams.findByStreamKey(input.streamKey);
    if (stream === null) {
      // NEVER log `input.streamKey` itself — see the class docstring.
      console.warn(
        '[user-stream] ignoring an "offline" hook: no stream matches this stream key'
      );
      return;
    }

    await this.streams.endById(stream.id, this.clock.now());
  }
}
