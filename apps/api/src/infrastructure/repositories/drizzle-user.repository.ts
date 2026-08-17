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
   * `query` is used as-is (not escaped for LIKE metacharacters `%`/`_`): the
   * caller (`ExploreUsers`) already trims and refuses to call this for an
   * empty/whitespace query, and an unescaped `%`/`_` inside a search term
   * only ever WIDENS or reshapes a still handle/display-name-only match —
   * never a route to another column.
   */
  async searchPublic(query: string, limit: number): Promise<FollowListRow[]> {
    const pattern = `${query}%`;
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
   * Counts through `follow_followee_created_idx` (on `followee_id,
   * created_at`) — grouping by `app_user.id`, itself the primary key, lets
   * Postgres select `handle`/`display_name`/`bio` without adding them to
   * `GROUP BY` (the functional-dependency rule), so the index backing this
   * join/count is the only index this query leans on. See
   * `drizzle-follow.repository.test.ts`'s "the indexes profile reads go
   * through" for the `pg_indexes` proof that index actually exists.
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
