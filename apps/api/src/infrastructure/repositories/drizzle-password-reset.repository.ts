import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { passwordResetTokens } from "../../db/schema";
import type {
  PasswordResetRepositoryPort,
  PasswordResetTokenRecord,
} from "../../application/ports/password-reset-repository.port";

// Deliberately excludes nothing — unlike `userColumns` in
// `drizzle-user.repository.ts`, there is no password hash or other secret in
// this table to keep out of a general-purpose select. `tokenHash` IS in
// here, and that is fine: it is the sha256 digest, not the plaintext token —
// see the port's own docstring.
const columns = {
  id: passwordResetTokens.id,
  userId: passwordResetTokens.userId,
  tokenHash: passwordResetTokens.tokenHash,
  expiresAt: passwordResetTokens.expiresAt,
  usedAt: passwordResetTokens.usedAt,
  createdAt: passwordResetTokens.createdAt,
} as const;

export class DrizzlePasswordResetRepository implements PasswordResetRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIpHash: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const [row] = await this.db
      .insert(passwordResetTokens)
      .values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        requestIpHash: input.requestIpHash,
      })
      .returning(columns);
    return row;
  }

  async findByHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const [row] = await this.db
      .select(columns)
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  /**
   * Backed by `password_reset_user_created_idx` (`userId`, `createdAt`) —
   * without it every rate-limit check seq-scans the whole table, the same
   * defect a previous phase found in the renewal passes.
   */
  async countForUserSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), gte(passwordResetTokens.createdAt, since)));
    return row?.count ?? 0;
  }

  /** Backed by `password_reset_ip_created_idx` (`requestIpHash`, `createdAt`) — same reasoning. */
  async countForIpSince(ipHash: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(passwordResetTokens)
      .where(
        and(eq(passwordResetTokens.requestIpHash, ipHash), gte(passwordResetTokens.createdAt, since))
      );
    return row?.count ?? 0;
  }

  /**
   * `usedAt IS NULL` is IN the predicate, not read first — the same
   * conditional-update shape `DrizzleJoinRequestRepository.decide` uses, and
   * for the same reason: two concurrent completions of the SAME token must
   * not both report success.
   */
  async markUsed(id: string): Promise<boolean> {
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ usedAt: sql`now()` })
      .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });
    return rows.length > 0;
  }

  async markAllOtherOutstandingUsed(userId: string, exceptId: string): Promise<number> {
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          ne(passwordResetTokens.id, exceptId),
          isNull(passwordResetTokens.usedAt)
        )
      )
      .returning({ id: passwordResetTokens.id });
    return rows.length;
  }
}
