import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, signupNotices } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleSignupNoticeRepository } from "./drizzle-signup-notice.repository";

beforeEach(resetDatabase);

const repo = new DrizzleSignupNoticeRepository(db);

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

const HOUR_MS = 60 * 60 * 1000;

describe("DrizzleSignupNoticeRepository", () => {
  it("records a notice and counts it back", async () => {
    const user = await seedUser();

    await repo.record(user.id);

    expect(await repo.countForUserSince(user.id, new Date(Date.now() - HOUR_MS))).toBe(1);
  });

  it("counts multiple records for the same user", async () => {
    const user = await seedUser();

    await repo.record(user.id);
    await repo.record(user.id);
    await repo.record(user.id);

    expect(await repo.countForUserSince(user.id, new Date(Date.now() - HOUR_MS))).toBe(3);
  });

  it("never counts another user's records", async () => {
    const userA = await seedUser({ handle: "a-user", email: "a@example.com" });
    const userB = await seedUser({ handle: "b-user", email: "b@example.com" });

    await repo.record(userA.id);

    expect(await repo.countForUserSince(userB.id, new Date(Date.now() - HOUR_MS))).toBe(0);
  });

  it("does not count records older than the given instant", async () => {
    const user = await seedUser();
    const now = new Date();
    const old = new Date(now.getTime() - 2 * HOUR_MS);

    await db.insert(signupNotices).values({ userId: user.id, createdAt: old });

    expect(await repo.countForUserSince(user.id, new Date(now.getTime() - HOUR_MS))).toBe(0);
  });

  it("returns 0 for a user with no records", async () => {
    const user = await seedUser();
    expect(await repo.countForUserSince(user.id, new Date(Date.now() - HOUR_MS))).toBe(0);
  });
});
