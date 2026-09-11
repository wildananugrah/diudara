import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers, communities } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleDocumentRepository } from "./drizzle-document.repository";

let counter = 0;

async function seedCommunity() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `docuser${counter}`,
      email: `docuser${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Doc User ${counter}`,
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

const repository = new DrizzleDocumentRepository(db);

function aDocument(communityId: string, uploaderId: string, name: string) {
  return {
    // Caller-generated, matching the real upload path — see the port's `id`.
    id: crypto.randomUUID(),
    communityId,
    uploaderId,
    name,
    contentType: "application/pdf",
    byteSize: 2_400_000,
  };
}

describe("DrizzleDocumentRepository", () => {
  beforeEach(resetDatabase);

  test("create returns the row in the shared projection, uploader joined", async () => {
    const { user, communityId } = await seedCommunity();

    const row = await repository.create(aDocument(communityId, user.id, "Rangkuman.pdf"));

    expect(row.name).toBe("Rangkuman.pdf");
    expect(row.contentType).toBe("application/pdf");
    expect(row.byteSize).toBe(2_400_000);
    expect(row.uploaderHandle).toBe(user.handle);
    expect(row.communityId).toBe(communityId);
  });

  /**
   * The projection is asserted as an exact key set, the discipline every other
   * repository in this app is held to: a path that quietly widens what it
   * selects should fail here.
   */
  test("the projection is CLOSED — these keys and no others", async () => {
    const { user, communityId } = await seedCommunity();

    const row = await repository.create(aDocument(communityId, user.id, "Rangkuman.pdf"));

    expect(Object.keys(row).sort()).toEqual([
      "byteSize",
      "communityId",
      "contentType",
      "createdAt",
      "id",
      "name",
      "uploaderDisplayName",
      "uploaderHandle",
    ]);
  });

  test("listByCommunity is newest first, one community, live rows only", async () => {
    const { user, communityId } = await seedCommunity();
    const other = await seedCommunity();

    const first = await repository.create(aDocument(communityId, user.id, "Pertama.pdf"));
    await repository.create(aDocument(communityId, user.id, "Kedua.pdf"));
    const gone = await repository.create(aDocument(communityId, user.id, "Dihapus.pdf"));
    await repository.create(aDocument(other.communityId, other.user.id, "Lain.pdf"));
    await repository.softDelete(gone.id);

    const rows = await repository.listByCommunity(communityId);

    // Compare NAMES, never row objects: a failing assertion holding a row
    // serialises everything joined to it.
    expect(rows.map((row) => row.name)).toEqual(["Kedua.pdf", "Pertama.pdf"]);
    expect(rows.map((row) => row.id)).toContain(first.id);
  });

  test("findById answers the row, then null once it is deleted", async () => {
    const { user, communityId } = await seedCommunity();
    const row = await repository.create(aDocument(communityId, user.id, "Rangkuman.pdf"));

    expect((await repository.findById(row.id))?.name).toBe("Rangkuman.pdf");

    await repository.softDelete(row.id);

    // Absence and deletion collapse into one answer — the caller turns both
    // into the same 404.
    expect(await repository.findById(row.id)).toBeNull();
  });

  test("findById answers null for an id that never existed", async () => {
    expect(await repository.findById("ffffffff-0000-4000-8000-000000000000")).toBeNull();
  });

  test("softDelete is idempotent and keeps the original deletion time", async () => {
    const { user, communityId } = await seedCommunity();
    const row = await repository.create(aDocument(communityId, user.id, "Rangkuman.pdf"));

    await repository.softDelete(row.id);
    // A second delete must touch NO row: the predicate carries
    // `deleted_at IS NULL`, so re-deleting cannot move the timestamp.
    await repository.softDelete(row.id);

    expect(await repository.findById(row.id)).toBeNull();
  });
});
