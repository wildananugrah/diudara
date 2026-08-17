import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, passwordResetTokens } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzlePasswordResetUnitOfWork } from "./drizzle-password-reset-unit-of-work";

beforeEach(resetDatabase);

const unitOfWork = () => new DrizzlePasswordResetUnitOfWork(db);

async function seedUser() {
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: "wildan",
      email: "wildan@example.com",
      whatsappNumber: null,
      passwordHash: "old-hash",
      displayName: "Wildan",
    })
    .returning();
  return row;
}

async function seedToken(userId: string, tokenHash: string) {
  const [row] = await db
    .insert(passwordResetTokens)
    .values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      requestIpHash: null,
    })
    .returning();
  return row;
}

/**
 * Mirrors `drizzle-payment-activation.unit-of-work.test.ts` exactly: proves
 * `passwordResets` and `users` are bound to the SAME transaction the unit of
 * work opens, not to the pool — the entire mechanism `PasswordResetUnitOfWorkPort`'s
 * docstring claims.
 */
describe("DrizzlePasswordResetUnitOfWork", () => {
  it("rolls back every write when the work throws, including a bumped epoch", async () => {
    const user = await seedUser();
    const token = await seedToken(user.id, "a".repeat(64));

    await expect(
      unitOfWork().run(async (repositories) => {
        await repositories.passwordResets.markUsed(token.id);
        await repositories.users.setPasswordAndBumpEpoch(user.id, "new-hash");
        throw new Error("boom, after both writes");
      })
    ).rejects.toThrow("boom, after both writes");

    const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.id, token.id));
    expect(row.usedAt).toBeNull();

    const [userRow] = await db.select().from(appUsers).where(eq(appUsers.id, user.id));
    expect(userRow.passwordHash).toBe("old-hash");
    expect(userRow.sessionEpoch).toBe(0);
  });

  it("commits all three writes together when the work succeeds", async () => {
    const user = await seedUser();
    const kept = await seedToken(user.id, "b".repeat(64));
    const other = await seedToken(user.id, "c".repeat(64));

    await unitOfWork().run(async (repositories) => {
      await repositories.passwordResets.markUsed(kept.id);
      await repositories.passwordResets.markAllOtherOutstandingUsed(user.id, kept.id);
      await repositories.users.setPasswordAndBumpEpoch(user.id, "new-hash");
    });

    const [keptRow] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, kept.id));
    const [otherRow] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, other.id));
    expect(keptRow.usedAt).not.toBeNull();
    expect(otherRow.usedAt).not.toBeNull();

    const [userRow] = await db.select().from(appUsers).where(eq(appUsers.id, user.id));
    expect(userRow.passwordHash).toBe("new-hash");
    expect(userRow.sessionEpoch).toBe(1);
  });

  it("keeps writes invisible to a pooled reader until the transaction commits", async () => {
    const user = await seedUser();

    let visibleMidTransaction = -1;
    await unitOfWork().run(async (repositories) => {
      await repositories.users.setPasswordAndBumpEpoch(user.id, "new-hash");
      const [row] = await db.select().from(appUsers).where(eq(appUsers.id, user.id));
      visibleMidTransaction = row.sessionEpoch;
    });

    expect(visibleMidTransaction).toBe(0);
    const [after] = await db.select().from(appUsers).where(eq(appUsers.id, user.id));
    expect(after.sessionEpoch).toBe(1);
  });
});
