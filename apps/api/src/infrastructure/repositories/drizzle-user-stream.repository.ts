import { and, desc, eq, lte } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, userStreams } from "../../db/schema";
import type {
  UserStreamRepositoryPort,
  UserStreamRow,
} from "../../application/ports/user-stream-repository.port";
import { UniqueRule } from "../../application/errors";
import { rethrowUniqueViolation } from "./pg-errors";

/**
 * A value that is not a uuid at all must be a MISS, not a Postgres
 * `invalid input syntax for type uuid` that becomes a 500. The retired
 * community `event` repository carried the identical literal for the
 * identical reason; this is the copy that outlived it.
 *
 * Task 4 is what made this load-bearing here rather than merely tidy.
 * nginx's `^~ /u/` location captures the id straight out of the PUBLIC
 * request URI and hands it, unvalidated, to
 * `AuthoriseStream.authoriseUserReadByStreamId`, which calls `findById`
 * below — so `GET /u/anything-at-all/index.m3u8` is a stranger choosing this
 * argument. Duplicated rather than shared for the same reason the other
 * repositories duplicate it: a `db/` module exporting a validation regex
 * every repository must remember to import is the arrangement this codebase
 * has already declined twice.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `user_stream.status` — see `UserStreamRow`'s docstring. */
const LIVE_STATUS = "live";
const ENDED_STATUS = "ended";

/**
 * The ONE projection every read path selects — never a bare `select()`, the
 * same rule `drizzle-post.repository.ts`'s `postColumns` follows, and for
 * the same reason: an explicit list is what keeps a later column (this
 * table's `stream_key` very much included) from reaching a caller by
 * accident just because a join widened.
 */
const userStreamColumns = {
  id: userStreams.id,
  ownerId: userStreams.ownerId,
  ownerHandle: appUsers.handle,
  ownerDisplayName: appUsers.displayName,
  title: userStreams.title,
  visibility: userStreams.visibility,
  streamKey: userStreams.streamKey,
  status: userStreams.status,
  startedAt: userStreams.startedAt,
  endedAt: userStreams.endedAt,
} as const;

export class DrizzleUserStreamRepository implements UserStreamRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async startLive(input: {
    ownerId: string;
    title: string;
    visibility: string;
    streamKey: string;
  }): Promise<UserStreamRow> {
    try {
      const [inserted] = await this.db
        .insert(userStreams)
        .values({
          ownerId: input.ownerId,
          title: input.title,
          visibility: input.visibility,
          streamKey: input.streamKey,
        })
        .returning({ id: userStreams.id });
      const row = await this.findById(inserted!.id);
      // The row was just inserted inside this call; a null here means the
      // projection join is broken, which is a bug rather than a missing row.
      if (row === null) throw new Error("stream disappeared immediately after insert");
      return row;
    } catch (err) {
      // Unlike `endById` (an UPDATE the caller can predicate on the row's
      // own current status), this is a bare INSERT: nothing here can see in
      // advance whether the owner already holds a `live` row before
      // attempting it. `user_stream_one_live` — the partial unique index —
      // is the only thing that can catch it, and it is the load-bearing
      // guarantee this whole table exists for: one live stream per person,
      // arbitrated by the database, not by a read-then-write pre-check that
      // would race under concurrency (see the design spec's §4, and 5a's
      // three-times-over lesson on the same shape).
      rethrowUniqueViolation(err, {
        user_stream_one_live: {
          rule: UniqueRule.userStreamOneLive,
          message: "sudah ada siaran yang sedang berlangsung",
        },
      });
    }
  }

  async findByStreamKey(streamKey: string): Promise<UserStreamRow | null> {
    const [row] = await this.db
      .select(userStreamColumns)
      .from(userStreams)
      .innerJoin(appUsers, eq(userStreams.ownerId, appUsers.id))
      .where(eq(userStreams.streamKey, streamKey))
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<UserStreamRow | null> {
    if (!UUID_PATTERN.test(id)) {
      // A MISS, not a driver error — see `UUID_PATTERN` above for who
      // chooses this string.
      return null;
    }
    const [row] = await this.db
      .select(userStreamColumns)
      .from(userStreams)
      .innerJoin(appUsers, eq(userStreams.ownerId, appUsers.id))
      .where(eq(userStreams.id, id))
      .limit(1);
    return row ?? null;
  }

  async listLive(): Promise<UserStreamRow[]> {
    return this.db
      .select(userStreamColumns)
      .from(userStreams)
      .innerJoin(appUsers, eq(userStreams.ownerId, appUsers.id))
      .where(eq(userStreams.status, LIVE_STATUS))
      .orderBy(desc(userStreams.startedAt));
  }

  async endById(id: string, endedAt: Date): Promise<UserStreamRow | null> {
    // `status = LIVE_STATUS` is IN the predicate, not read first — the same
    // atomic-predicate shape the retired community `event` repository used
    // for its own `markEnded`, and for the same reason: it is what makes the
    // transition safe under a
    // flapping lifecycle webhook, or the hourly sweep racing the webhook
    // for the same row. Only the caller that actually flips the status gets
    // a non-null result back; a repeat call is a no-op.
    const [updated] = await this.db
      .update(userStreams)
      .set({ status: ENDED_STATUS, endedAt })
      .where(and(eq(userStreams.id, id), eq(userStreams.status, LIVE_STATUS)))
      .returning({ id: userStreams.id });
    if (updated === undefined) return null;
    return this.findById(updated.id);
  }

  async listStaleLive(olderThan: Date): Promise<UserStreamRow[]> {
    return this.db
      .select(userStreamColumns)
      .from(userStreams)
      .innerJoin(appUsers, eq(userStreams.ownerId, appUsers.id))
      .where(and(eq(userStreams.status, LIVE_STATUS), lte(userStreams.startedAt, olderThan)))
      .orderBy(userStreams.startedAt);
  }
}
