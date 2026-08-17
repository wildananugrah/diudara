import { asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, follows } from "../../db/schema";
import { UniqueRule } from "../../application/errors";
import { rethrowUniqueViolation } from "./pg-errors";
import { clampLimit } from "./drizzle-follow.repository";
import type {
  UserCredentials,
  UserRecord,
  UserRepositoryPort,
} from "../../application/ports/user-repository.port";
import type { FollowListRow } from "../../application/ports/follow-repository.port";

/**
 * Public row shape for `searchPublic`/`newestPublic`/`mostFollowedPublic`:
 * handle, display name and bio ONLY — the exact same three columns
 * `DrizzleFollowRepository`'s `publicListColumns` projects, and the SAME
 * `FollowListRow` type. Never `email`, never `id` — see
 * `UserRepositoryPort.searchPublic`'s own docstring for why `email` in
 * particular is non-negotiable here.
 */
const publicListColumns = {
  handle: appUsers.handle,
  displayName: appUsers.displayName,
  bio: appUsers.bio,
} as const;

// Columns returned by the general-purpose methods below. Deliberately excludes
// passwordHash: password hashes must never leave the repository layer except
// through findCredentialsByEmail's own explicit column list below. Listing
// columns explicitly means the hash is never fetched from the database in the
// first place, not merely stripped afterwards.
const userColumns = {
  id: appUsers.id,
  handle: appUsers.handle,
  email: appUsers.email,
  whatsappNumber: appUsers.whatsappNumber,
  displayName: appUsers.displayName,
  bio: appUsers.bio,
  sessionEpoch: appUsers.sessionEpoch,
  createdAt: appUsers.createdAt,
} as const;

export class DrizzleUserRepository implements UserRepositoryPort {
  /**
   * `DatabaseExecutor`, not the pooled client specifically — Task 5's
   * `DrizzlePasswordResetUnitOfWork` constructs this against an open
   * transaction handle (`tx`), exactly the way `DrizzleSubscriptionRepository`
   * and the rest are constructed inside `DrizzlePaymentActivationUnitOfWork`,
   * so that `setPasswordAndBumpEpoch` joins the SAME transaction as the token
   * writes around it. `PgTransaction` satisfies `DatabaseExecutor`, so this
   * needed no cast — see `db/client.ts`'s own docstring on the type.
   */
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    handle: string;
    email: string;
    whatsappNumber: string | null;
    passwordHash: string;
    displayName: string;
  }): Promise<UserRecord> {
    try {
      const [row] = await this.db
        .insert(appUsers)
        .values({
          handle: input.handle,
          email: input.email,
          whatsappNumber: input.whatsappNumber,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
        })
        .returning(userColumns);
      return row;
    } catch (err) {
      // Two simultaneous signups can both pass any application-side
      // uniqueness check; the unique index is the real arbiter, so translate
      // its violation here. Letting it escape would land in the
      // unhandled-error path, where the driver error's bound parameters
      // include the password hash. Mapped separately so the caller can tell
      // handle from email.
      rethrowUniqueViolation(err, {
        app_user_handle_unique: {
          rule: UniqueRule.userHandle,
          message: "handle is already taken",
        },
        app_user_email_unique: {
          rule: UniqueRule.userEmail,
          message: "email is already registered",
        },
      });
    }
  }

  async findByHandle(handle: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select(userColumns)
      .from(appUsers)
      .where(eq(appUsers.handle, handle))
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select(userColumns)
      .from(appUsers)
      .where(eq(appUsers.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select(userColumns)
      .from(appUsers)
      .where(eq(appUsers.email, email))
      .limit(1);
    return row ?? null;
  }

  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    const [row] = await this.db
      .select({
        id: appUsers.id,
        passwordHash: appUsers.passwordHash,
        sessionEpoch: appUsers.sessionEpoch,
      })
      .from(appUsers)
      .where(eq(appUsers.email, email))
      .limit(1);
    return row ?? null;
  }

  async updateProfile(
    id: string,
    patch: { displayName?: string; bio?: string | null; whatsappNumber?: string | null }
  ): Promise<UserRecord | null> {
    const set: { displayName?: string; bio?: string | null; whatsappNumber?: string | null } = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.bio !== undefined) set.bio = patch.bio;
    if (patch.whatsappNumber !== undefined) set.whatsappNumber = patch.whatsappNumber;

    if (Object.keys(set).length === 0) {
      return this.findById(id);
    }

    const [row] = await this.db
      .update(appUsers)
      .set(set)
      .where(eq(appUsers.id, id))
      .returning(userColumns);
    return row ?? null;
  }

  /**
   * `session_epoch = session_epoch + 1` in the database, not read-then-write:
   * two concurrent resets for the same user must both land, and an
   * application-side `current + 1` from a stale read would lose one.
   */
  async setPasswordAndBumpEpoch(id: string, passwordHash: string): Promise<boolean> {
    const rows = await this.db
      .update(appUsers)
      .set({ passwordHash, sessionEpoch: sql`${appUsers.sessionEpoch} + 1` })
      .where(eq(appUsers.id, id))
      .returning({ id: appUsers.id });
    return rows.length > 0;
  }

  /**
   * Case-insensitive PREFIX match over `handle` OR `display_name` ONLY — see
   * the port docstring for why `email`/`whatsapp_number` are never touched
   * here. `query` is passed to Postgres as a bound parameter (no string
   * interpolation), so this is not a SQL-injection concern; it is a
   * column-selection one, and the columns selected below are the whole of
   * the guarantee.
   *
   * `query`'s own `%`/`_`/`\` are ESCAPED before the trailing `%` is
   * appended (review round 1, Important 2) — `_` in particular is a LEGAL
   * handle character (`domain/handle.ts`'s `/^[a-z0-9_]{3,30}$/`), so
   * without escaping, searching an exact, valid handle like
   * `budi_santoso` returned `budi_santoso` AND `budi1santoso` AND
   * `budixsantoso` — three rows for what should be a single exact match,
   * on the mainline path, not an edge case. `q=%` matched every user in
   * the table for the same reason. Escaping the backslash too closes the
   * related case where a trailing `\` in `query` would make the appended
   * `%` combine into an escaped, literal percent instead of a wildcard.
   * Metacharacters were never a SECURITY hole (the `or(...)` below is a
   * fixed two-column list; nothing in `query` can reach `email` or
   * `password_hash`, and a full unbounded dump is still capped by
   * `clampLimit` — measured directly in Postgres for `'%aa'` repeated 30
   * times, twenty `%`-segments over 2000 rows, and a 100,000-character
   * query, all under 10ms with no backtracking blowup), only a
   * correctness one, which is why this fix changes ONLY the pattern
   * construction below and not the query shape.
   */
  async searchPublic(query: string, limit: number): Promise<FollowListRow[]> {
    const pattern = `${escapeLikePattern(query)}%`;
    return this.db
      .select(publicListColumns)
      .from(appUsers)
      .where(or(ilike(appUsers.handle, pattern), ilike(appUsers.displayName, pattern)))
      .orderBy(asc(appUsers.handle))
      .limit(clampLimit(limit));
  }

  /** Newest accounts first. */
  async newestPublic(limit: number): Promise<FollowListRow[]> {
    return this.db
      .select(publicListColumns)
      .from(appUsers)
      // id as a tiebreaker, same reasoning as `DrizzleFollowRepository.listFollowers`:
      // `createdAt` alone is not a total order.
      .orderBy(desc(appUsers.createdAt), desc(appUsers.id))
      .limit(clampLimit(limit));
  }

  /**
   * Most followers first; users with zero followers last. `LEFT JOIN` (not
   * an inner join) is what keeps a zero-follower user in the result at all —
   * an inner join would drop them entirely rather than sorting them last.
   * `count(follows.id)`, not the bare `count()`: the left join still
   * produces one row per zero-follower user with every `follows` column
   * `NULL`, and `count()` (equivalent to `COUNT(*)`) would count that
   * phantom row as one follower; `count(follows.id)` counts only non-null
   * ids, giving the correct zero.
   *
   * DOES NOT go through `follow_followee_created_idx`, or any index — this
   * docstring used to claim otherwise (so did the task brief that asked for
   * this method; both were wrong, unmeasured). `EXPLAIN (ANALYZE, BUFFERS)`
   * against 2,000 users / 2,000 follow rows, `ANALYZE`d, shows:
   *
   *   HashAggregate -> Hash Right Join -> Seq Scan on follow / Seq Scan on app_user
   *   Execution Time: 1.787 ms
   *
   * Grouping by `app_user.id` selects EVERY row of `app_user` regardless of
   * `follow`, which forces a full scan of that table no matter what index
   * exists on `follow` — the index was never going to help THIS query
   * shape, at any table size. The query is correct and fast (1.8ms at this
   * scale); only the earlier claim that it was index-backed was false. See
   * `schema.ts`'s own note on a prior instance of exactly this mistake
   * (a comment claiming two queries were indexed when `pg_indexes` showed
   * otherwise) — this is the same failure mode, corrected here rather than
   * repeated.
   */
  async mostFollowedPublic(limit: number): Promise<FollowListRow[]> {
    return this.db
      .select(publicListColumns)
      .from(appUsers)
      .leftJoin(follows, eq(follows.followeeId, appUsers.id))
      .groupBy(appUsers.id)
      .orderBy(desc(count(follows.id)), asc(appUsers.handle))
      .limit(clampLimit(limit));
  }
}

/**
 * Escapes Postgres `LIKE`/`ILIKE` metacharacters (`%`, `_`) and the escape
 * character itself (`\`) in `query` before `searchPublic` appends its own
 * trailing `%`. Postgres's DEFAULT escape character for `LIKE`/`ILIKE` is
 * `\`, so prefixing each of the three with `\` is sufficient — no `ESCAPE`
 * clause needed.
 *
 * See `searchPublic`'s own docstring for why this exists: `_` is a legal
 * character in a real handle, so an unescaped search for an EXACT handle
 * like `budi_santoso` matched two other users too (`budi1santoso`,
 * `budixsantoso`) before this fix.
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}
