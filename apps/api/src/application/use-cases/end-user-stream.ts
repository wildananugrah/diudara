import type { ClockPort } from "../ports/clock.port";
import type { UserStreamRepositoryPort } from "../ports/user-stream-repository.port";

/** The two lifecycle edges MediaMTX's hooks report — see `HandleStreamLifecycle`'s own docstring. */
export type UserStreamLifecycleHook = "online" | "offline";

/**
 * `POST /webhooks/mediamtx/lifecycle`'s decision logic for the `u/<key>` world — the
 * sibling `HandleStreamLifecycle` never grew (its own docstring says so explicitly:
 * "wiring it up is later work, not this one"). This is that later work, but it is a
 * SEPARATE class rather than a branch added to that one, because the two worlds'
 * `online` hooks do genuinely different things: the community world's `online`
 * transitions a `scheduled` event to `live` (`markLive`, plus an activity-log row and
 * one `notify_stream_live` outbox row per member) — real domain work with a real
 * "first time" to guard. The user world has none of that: `user_stream` is already
 * `live` the INSTANT `StartUserStream.execute` inserts the row (design spec §7,
 * *"Mulai siaran creates the row"*) — there is no `scheduled` state, and therefore no
 * transition left for `online` to make. Folding this into `HandleStreamLifecycle`
 * would give it an `online` branch with nothing to do, which is worse than no branch
 * at all: a reader has to prove the no-op is deliberate rather than see one class
 * with one job.
 *
 * `POST /webhooks/mediamtx/lifecycle` (the route) resolves which class to call by
 * parsing `$MTX_PATH` with `parseStreamPath` ONCE, itself, and dispatching on
 * `parsed.world` — see that route's own docstring. This class therefore takes the
 * BARE key (`parsed.key`), never the raw `u/<key>` path; unlike
 * `HandleStreamLifecycle.execute`, which still takes the raw path because its own
 * signature could not change (Task 6's brief leaves that file untouched).
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
 * AN UNKNOWN STREAM KEY IS A NORMAL, LOGGED, SILENT-TO-THE-CALLER NO-OP — same
 * reasoning as `HandleStreamLifecycle`'s own docstring: a stale session, a probe, or
 * a race with the row not yet committed must not make MediaMTX retry forever, and the
 * key itself is NEVER logged (it is `user_stream.stream_key`, a SECRET — see
 * `UserStreamRepositoryPort`'s own docstring).
 *
 * `endById`'s status check is IN the UPDATE's predicate, not a preceding read (see
 * that port's docstring) — the same atomic-predicate shape `HandleStreamLifecycle`
 * relies on for the community world, and for the identical reason: it is what makes
 * the `offline` branch safe under a flapping publisher (repeated `offline`) or a race
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
