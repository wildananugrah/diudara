/**
 * One broadcast a person is running, or has run, on their own profile —
 * `user_stream`, Task 1 of Phase 7. `ownerHandle`/`ownerDisplayName` are
 * ALWAYS joined in from `app_user`, the same "flat, with the public fields
 * of the owner joined in" shape `PostRow` uses and for the same reason:
 * Siaran's listing needs a name to show next to every live row, and folding
 * that decision into every caller here means the wire shape is decided in
 * exactly one place (a future `toStreamView`), not re-derived per route.
 *
 * `streamKey` IS present — this is the repository layer, not the wire, and
 * `AuthoriseStream` (Task 4) resolves a publish/read entirely off it. It is
 * a SECRET: never logged — a rule this table inherits unchanged from the old
 * community world's own stream keys — and a caller building a wire response must
 * pick fields explicitly rather than spread this type.
 */
export interface UserStreamRow {
  id: string;
  ownerId: string;
  ownerHandle: string;
  ownerDisplayName: string;
  title: string;
  /** `public` | `members` — widened to a string here, same reasoning as `PostRow.visibility`. */
  visibility: string;
  streamKey: string;
  /** `live` | `ended`. */
  status: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface UserStreamRepositoryPort {
  /**
   * Inserts a `live` row. THIS is the write the partial unique index
   * `user_stream_one_live` arbitrates: a bare INSERT, so nothing here can
   * see in advance whether the owner already holds a `live` row — the same
   * shape the retired community subscription repository used for its own
   * `createActiveWithoutBilling`, and for the same reason (a read-then-write
   * pre-check is always a TOCTOU
   * race under concurrency; 5a established this three times over). Throws
   * `UniqueViolationError` when the owner already has one `live`.
   */
  startLive(input: {
    ownerId: string;
    title: string;
    visibility: string;
    streamKey: string;
  }): Promise<UserStreamRow>;

  /**
   * Unscoped by owner ON PURPOSE — `AuthoriseStream` (Task 4) knows only the
   * key baked into the `u/<key>` publish/read path and has no authenticated
   * owner to scope by. One of the TWO sanctioned unscoped lookups on this
   * port — this one and `findById` below, and no others; the retired community
   * `event` port documented the identical exception for the identical reason.
   * `null` when no row carries this key.
   */
  findByStreamKey(streamKey: string): Promise<UserStreamRow | null>;

  /**
   * Unscoped by owner ON PURPOSE — the lifecycle webhook and the hourly
   * sweep both resolve a specific row by id with no authenticated caller in
   * the picture — the second of the two sanctioned unscoped lookups, alongside
   * `findByStreamKey` above. `null` when the id does not exist.
   */
  findById(id: string): Promise<UserStreamRow | null>;

  /**
   * Every `live` row, newest first — Siaran's own listing (spec §8). Visible
   * to everyone, signed in or not.
   *
   * **UNBOUNDED, AND THAT IS THE DECISION, NOT AN OVERSIGHT** (M6, final
   * whole-branch review). There is no limit and no cursor because
   * `user_stream_one_live` — the partial unique index this whole table is
   * arranged around — caps the result at one row per person, so the ceiling
   * is "people broadcasting simultaneously", not "streams ever created". At
   * this platform's scale that is a page, and a paginated listing would need
   * a cursor, a wire shape to carry it, and a Siaran page that knows how to
   * ask for more — real surface area bought against a bound the database
   * already enforces. Revisit when simultaneous broadcasters are counted in
   * hundreds; the query is already `status`-indexed for it.
   */
  listLive(): Promise<UserStreamRow[]>;

  /**
   * Transitions to `ended`, but ONLY from `live` — the status check is IN
   * the UPDATE's predicate, not a preceding read, the same atomic-predicate
   * shape the retired community `event` port used for its own `markEnded`,
   * and for the same reason: it is
   * what makes the transition safe under a flapping lifecycle webhook, or
   * the hourly sweep racing the webhook for the same row. Returns `null`
   * when `id` does not exist or the row is already `ended` — either way,
   * nothing to do.
   */
  endById(id: string, endedAt: Date): Promise<UserStreamRow | null>;

  /**
   * Every row still `live` with `startedAt` at or before `olderThan` — the
   * target set for the hourly sweep the design spec's §7 requires: a missed
   * lifecycle webhook must not leave a row `live` forever, because the
   * partial unique index above means that owner could never go live again.
   * This is a cap on AGE, not a liveness check (§7) — it has no opinion on
   * whether the stream is actually still running.
   */
  listStaleLive(olderThan: Date): Promise<UserStreamRow[]>;
}
