import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { creators, communities } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("phase 2 schema changes", () => {
  it("stores a creator with a password hash and no whatsapp number", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", email: "budi@example.com", passwordHash: "$argon2id$fake" })
      .returning();

    expect(creator.whatsappNumber).toBeNull();
    expect(creator.passwordHash).toBe("$argon2id$fake");
  });

  it("rejects two communities with the same slug", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", email: "budi@example.com" })
      .returning();

    await db
      .insert(communities)
      .values({ creatorId: creator.id, name: "Kelas Budi", slug: "kelas-budi" });

    let failed = false;
    try {
      await db
        .insert(communities)
        .values({ creatorId: creator.id, name: "Kelas Budi Lagi", slug: "kelas-budi" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    const rows = await db.select().from(communities);
    expect(rows.length).toBe(1);
  });
});
