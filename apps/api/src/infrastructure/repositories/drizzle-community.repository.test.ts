import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommunityRepository } from "./drizzle-community.repository";

beforeEach(resetDatabase);

async function makeCreator(email: string) {
  const [row] = await db.insert(creators).values({ name: "C", email }).returning();
  return row;
}

describe("DrizzleCommunityRepository", () => {
  it("creates a community and lists it for its creator", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const creator = await makeCreator("a@example.com");

    const created = await repository.create({
      creatorId: creator.id,
      name: "Kelas Budi",
      slug: "kelas-budi",
      niche: "bimbel",
    });

    const listed = await repository.listByCreator(creator.id);
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].slug).toBe("kelas-budi");
  });

  it("does not return another creator's community", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const owner = await makeCreator("owner@example.com");
    const stranger = await makeCreator("stranger@example.com");

    const created = await repository.create({
      creatorId: owner.id,
      name: "Kelas Budi",
      slug: "kelas-budi",
    });

    expect(await repository.findByIdForCreator(created.id, stranger.id)).toBeNull();
    expect(await repository.findByIdForCreator(created.id, owner.id)).not.toBeNull();
    expect(await repository.listByCreator(stranger.id)).toEqual([]);
  });

  it("reports whether a slug is taken", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const creator = await makeCreator("a@example.com");
    await repository.create({ creatorId: creator.id, name: "Kelas", slug: "kelas-budi" });

    expect(await repository.slugExists("kelas-budi")).toBe(true);
    expect(await repository.slugExists("belum-ada")).toBe(false);
  });

  it("refuses to update another creator's community", async () => {
    const repository = new DrizzleCommunityRepository(db);
    const owner = await makeCreator("owner@example.com");
    const stranger = await makeCreator("stranger@example.com");
    const created = await repository.create({
      creatorId: owner.id,
      name: "Asli",
      slug: "asli",
    });

    const result = await repository.update(created.id, stranger.id, { name: "Dibajak" });
    expect(result).toBeNull();

    const stillThere = await repository.findByIdForCreator(created.id, owner.id);
    expect(stillThere?.name).toBe("Asli");
  });
});
