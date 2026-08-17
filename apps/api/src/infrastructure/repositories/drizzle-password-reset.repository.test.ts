import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, passwordResetTokens } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzlePasswordResetRepository } from "./drizzle-password-reset.repository";

beforeEach(resetDatabase);

const repo = new DrizzlePasswordResetRepository(db);

async function seedUser(overrides: { email?: string; handle?: string } = {}) {
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: overrides.handle ?? "wildan",
      email: overrides.email ?? "wildan@example.com",
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: "Wildan",
    })
    .returning();
  return row;
}

const THIRTY_MIN_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe("DrizzlePasswordResetRepository", () => {
  describe("create / findByHash", () => {
    it("creates a row and finds it by its hash", async () => {
      const user = await seedUser();
      const expiresAt = new Date(Date.now() + THIRTY_MIN_MS);

      const created = await repo.create({
        userId: user.id,
        tokenHash: "a".repeat(64),
        expiresAt,
        requestIpHash: "b".repeat(64),
      });

      expect(created.userId).toBe(user.id);
      expect(created.usedAt).toBeNull();

      const found = await repo.findByHash("a".repeat(64));
      expect(found?.id).toBe(created.id);
      expect(found?.userId).toBe(user.id);
    });

    it("returns null for an unknown hash", async () => {
      expect(await repo.findByHash("z".repeat(64))).toBeNull();
    });

    /**
     * THE central guarantee this table exists for: a database read must
     * never yield a working reset link. Only the hash lives in the row —
     * this proves the plaintext appears nowhere in the row, not merely that
     * the repository's typed methods don't hand one back.
     */
    it("never stores the plaintext token anywhere in the row — only its hash", async () => {
      const user = await seedUser();
      const plaintextToken = "this-is-the-secret-plaintext-token-never-store-me";
      const tokenHash = "c".repeat(64);

      await repo.create({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      const rows = await db.select().from(passwordResetTokens);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(plaintextToken);
      expect(rows[0].tokenHash).toBe(tokenHash);
    });

    it("rejects a second row with the same token hash — the unique index is the real arbiter", async () => {
      const user = await seedUser();
      await repo.create({
        userId: user.id,
        tokenHash: "d".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      await expect(
        repo.create({
          userId: user.id,
          tokenHash: "d".repeat(64),
          expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
          requestIpHash: null,
        })
      ).rejects.toThrow();
    });
  });

  describe("countForUserSince / countForIpSince", () => {
    it("counts only rows created since the given instant, for this user", async () => {
      const user = await seedUser();
      const now = new Date();
      const old = new Date(now.getTime() - 2 * HOUR_MS);

      await repo.create({
        userId: user.id,
        tokenHash: "e".repeat(64),
        expiresAt: new Date(now.getTime() + THIRTY_MIN_MS),
        requestIpHash: null,
      });
      // Backdated directly via the table, since `create` always uses `now()`.
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: "f".repeat(64),
        expiresAt: new Date(now.getTime() + THIRTY_MIN_MS),
        requestIpHash: null,
        createdAt: old,
      });

      expect(await repo.countForUserSince(user.id, new Date(now.getTime() - HOUR_MS))).toBe(1);
    });

    it("never counts another user's rows", async () => {
      const userA = await seedUser({ handle: "a-user", email: "a@example.com" });
      const userB = await seedUser({ handle: "b-user", email: "b@example.com" });
      await repo.create({
        userId: userA.id,
        tokenHash: "g".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      expect(await repo.countForUserSince(userB.id, new Date(Date.now() - HOUR_MS))).toBe(0);
    });

    it("counts rows by IP hash, since the given instant", async () => {
      const user = await seedUser();
      await repo.create({
        userId: user.id,
        tokenHash: "h".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: "shared-ip-hash",
      });

      expect(
        await repo.countForIpSince("shared-ip-hash", new Date(Date.now() - HOUR_MS))
      ).toBe(1);
      expect(
        await repo.countForIpSince("other-ip-hash", new Date(Date.now() - HOUR_MS))
      ).toBe(0);
    });
  });

  describe("markUsed", () => {
    it("marks an unused token used and returns true", async () => {
      const user = await seedUser();
      const created = await repo.create({
        userId: user.id,
        tokenHash: "i".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      expect(await repo.markUsed(created.id)).toBe(true);

      const found = await repo.findByHash("i".repeat(64));
      expect(found?.usedAt).not.toBeNull();
    });

    it("returns false for a token that is already used — the conditional update refuses a second win", async () => {
      const user = await seedUser();
      const created = await repo.create({
        userId: user.id,
        tokenHash: "j".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      expect(await repo.markUsed(created.id)).toBe(true);
      expect(await repo.markUsed(created.id)).toBe(false);
    });

    it("returns false for an unknown id", async () => {
      expect(await repo.markUsed("00000000-0000-4000-8000-000000000000")).toBe(false);
    });
  });

  describe("markAllOtherOutstandingUsed", () => {
    it("marks every other unused token for the user used, and leaves the excepted one alone", async () => {
      const user = await seedUser();
      const kept = await repo.create({
        userId: user.id,
        tokenHash: "k".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });
      await repo.create({
        userId: user.id,
        tokenHash: "l".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });
      await repo.create({
        userId: user.id,
        tokenHash: "m".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      const affected = await repo.markAllOtherOutstandingUsed(user.id, kept.id);
      expect(affected).toBe(2);

      expect((await repo.findByHash("k".repeat(64)))?.usedAt).toBeNull();
      expect((await repo.findByHash("l".repeat(64)))?.usedAt).not.toBeNull();
      expect((await repo.findByHash("m".repeat(64)))?.usedAt).not.toBeNull();
    });

    it("never touches another user's token", async () => {
      const userA = await seedUser({ handle: "a-user", email: "a@example.com" });
      const userB = await seedUser({ handle: "b-user", email: "b@example.com" });
      const keptA = await repo.create({
        userId: userA.id,
        tokenHash: "n".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });
      await repo.create({
        userId: userB.id,
        tokenHash: "o".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });

      const affected = await repo.markAllOtherOutstandingUsed(userA.id, keptA.id);
      expect(affected).toBe(0);
      expect((await repo.findByHash("o".repeat(64)))?.usedAt).toBeNull();
    });

    it("does not re-mark an already-used token, and does not count it as affected", async () => {
      const user = await seedUser();
      const kept = await repo.create({
        userId: user.id,
        tokenHash: "p".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });
      const alreadyUsed = await repo.create({
        userId: user.id,
        tokenHash: "q".repeat(64),
        expiresAt: new Date(Date.now() + THIRTY_MIN_MS),
        requestIpHash: null,
      });
      await repo.markUsed(alreadyUsed.id);

      const affected = await repo.markAllOtherOutstandingUsed(user.id, kept.id);
      expect(affected).toBe(0);
    });
  });
});
