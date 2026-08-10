import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { aiConversations, aiMessages, aiUsage, creators } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

async function seedCreator() {
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${Date.now()}-${Math.random()}@example.com` })
    .returning();
  return creator;
}

describe("phase 7 schema", () => {
  it("stores a conversation and its messages", async () => {
    const creator = await seedCreator();
    const [conversation] = await db
      .insert(aiConversations)
      .values({ creatorId: creator.id })
      .returning();

    await db.insert(aiMessages).values({
      conversationId: conversation.id,
      role: "user",
      content: "Komunitas saya tentang bimbel matematika",
    });

    const rows = await db.select().from(aiMessages);
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("user");
  });

  it("rejects a second usage row for the same creator and day", async () => {
    const creator = await seedCreator();
    await db.insert(aiUsage).values({ creatorId: creator.id, usageDate: "2026-08-10" });

    let failed = false;
    try {
      await db.insert(aiUsage).values({ creatorId: creator.id, usageDate: "2026-08-10" });
    } catch {
      failed = true;
    }

    // This constraint is what makes the spend cap safe under concurrency:
    // the check-and-increment is one upsert, and the database arbitrates.
    expect(failed).toBe(true);
    expect((await db.select().from(aiUsage)).length).toBe(1);
  });

  it("defaults a usage row to zero messages", async () => {
    const creator = await seedCreator();
    const [row] = await db
      .insert(aiUsage)
      .values({ creatorId: creator.id, usageDate: "2026-08-10" })
      .returning();
    expect(row.messageCount).toBe(0);
  });
});
