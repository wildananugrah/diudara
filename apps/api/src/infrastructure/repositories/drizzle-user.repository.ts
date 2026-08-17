import { eq, sql } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { appUsers } from "../../db/schema";
import { UniqueRule } from "../../application/errors";
import { rethrowUniqueViolation } from "./pg-errors";
import type {
  UserCredentials,
  UserRecord,
  UserRepositoryPort,
} from "../../application/ports/user-repository.port";

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
  constructor(private readonly db: typeof DbClient) {}

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
    patch: { displayName?: string; bio?: string | null }
  ): Promise<UserRecord | null> {
    const set: { displayName?: string; bio?: string | null } = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.bio !== undefined) set.bio = patch.bio;

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
}
