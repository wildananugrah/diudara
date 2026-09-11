import { describe, expect, test, beforeEach } from "bun:test";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./client";
import { appUsers, communities, communityDocuments } from "./schema";
import { resetDatabase } from "./test-helpers";

let counter = 0;

async function seedCommunity() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `docowner${counter}`,
      email: `docowner${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Doc Owner ${counter}`,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: user!.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();
  return { user: user!, communityId: community!.id };
}

describe("community_document", () => {
  beforeEach(resetDatabase);

  test("a row with the required fields is accepted, and is live by default", async () => {
    const { user, communityId } = await seedCommunity();

    const [row] = await db
      .insert(communityDocuments)
      .values({
        communityId,
        uploaderId: user.id,
        name: "Rangkuman Trigonometri.pdf",
        contentType: "application/pdf",
        byteSize: 2_400_000,
      })
      .returning();

    expect(row!.name).toBe("Rangkuman Trigonometri.pdf");
    // Soft delete, matching `post`: a fresh row is live, and every read path
    // filters this rather than relying on the row being gone.
    expect(row!.deletedAt).toBeNull();
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  test("the listing index's shape: one community's live rows, newest first", async () => {
    const { user, communityId } = await seedCommunity();
    const other = await seedCommunity();
    const base = { uploaderId: user.id, contentType: "application/pdf", byteSize: 1 };

    await db.insert(communityDocuments).values([
      { ...base, communityId, name: "Lama.pdf", createdAt: new Date("2026-09-01T00:00:00.000Z") },
      { ...base, communityId, name: "Baru.pdf", createdAt: new Date("2026-09-05T00:00:00.000Z") },
      {
        ...base,
        communityId,
        name: "Dihapus.pdf",
        createdAt: new Date("2026-09-09T00:00:00.000Z"),
        deletedAt: new Date("2026-09-10T00:00:00.000Z"),
      },
      { ...base, uploaderId: other.user.id, communityId: other.communityId, name: "Komunitas lain.pdf" },
    ]);

    const rows = await db
      .select({ name: communityDocuments.name })
      .from(communityDocuments)
      .where(
        and(eq(communityDocuments.communityId, communityId), isNull(communityDocuments.deletedAt))
      )
      .orderBy(desc(communityDocuments.createdAt));

    expect(rows.map((row) => row.name)).toEqual(["Baru.pdf", "Lama.pdf"]);
  });

  /**
   * `byte_size` is `integer`, and 25 MB is comfortably inside its range — but
   * asserting it means a later cap raise that overflows the column fails
   * here rather than in production.
   */
  test("byte_size holds a file at the cap", async () => {
    const { user, communityId } = await seedCommunity();

    const [row] = await db
      .insert(communityDocuments)
      .values({
        communityId,
        uploaderId: user.id,
        name: "Besar.pdf",
        contentType: "application/pdf",
        byteSize: 25 * 1024 * 1024,
      })
      .returning();

    expect(row!.byteSize).toBe(26_214_400);
  });

  test("resetDatabase clears documents, so a suite that made one leaves none", async () => {
    const { user, communityId } = await seedCommunity();
    await db.insert(communityDocuments).values({
      communityId,
      uploaderId: user.id,
      name: "Akan dihapus.pdf",
      contentType: "application/pdf",
      byteSize: 1,
    });

    await resetDatabase();

    expect(await db.select().from(communityDocuments)).toHaveLength(0);
  });
});
