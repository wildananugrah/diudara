import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCommunityRepository } from "./drizzle-community.repository";

beforeEach(resetDatabase);

async function seedUser(handle: string): Promise<string> {
  const [row] = await db
    .insert(appUsers)
    .values({
      handle,
      email: `${handle}@example.com`,
      passwordHash: "hash",
      displayName: handle,
    })
    .returning({ id: appUsers.id });
  return row!.id;
}

function repo() {
  return new DrizzleCommunityRepository(db);
}

describe("DrizzleCommunityRepository", () => {
  it("creating a community also makes the owner a member, in one transaction", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(created.slug).toBe("kelas-desain");
    expect(await repo().memberCountFor(created.id)).toBe(1);
    expect(await repo().isMember(created.id, ownerId)).toBe(true);
  });

  it("the owner's membership row carries the owner role", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    const members = await repo().listMembers(created.id, 50);
    expect(members.map((m) => `${m.handle}:${m.role}`).join(",")).toBe("wildan:owner");
  });

  it("findById returns the record for a live id and null for an unknown one", async () => {
    const ownerId = await seedUser("wildan");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    const found = await repo().findById(created.id);
    expect(found?.slug).toBe("kelas-desain");
    expect(found?.ownerId).toBe(ownerId);

    expect(await repo().findById("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("joining twice writes one row and reports the second as already present", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });

    expect(await repo().join(created.id, joinerId)).toBe(true);
    expect(await repo().join(created.id, joinerId)).toBe(false);
    expect(await repo().memberCountFor(created.id)).toBe(2);
  });

  it("leaving is idempotent and reports whether anything was removed", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({
      ownerId,
      slug: "kelas-desain",
      name: "Kelas Desain",
      category: "Skill Digital",
      description: null,
    });
    await repo().join(created.id, joinerId);

    expect(await repo().leave(created.id, joinerId)).toBe(true);
    expect(await repo().leave(created.id, joinerId)).toBe(false);
    expect(await repo().memberCountFor(created.id)).toBe(1);
  });

  it("browse filters by category and by a case-insensitive name match", async () => {
    const ownerId = await seedUser("wildan");
    await repo().create({ ownerId, slug: "kelas-desain", name: "Kelas Desain", category: "Skill Digital", description: null });
    await repo().create({ ownerId, slug: "bimbel-sbmptn", name: "Bimbel SBMPTN", category: "Bimbel & Ujian", description: null });

    const byCategory = await repo().browse({ search: "", category: "Skill Digital", limit: 24 });
    expect(byCategory.map((c) => c.slug).join(",")).toBe("kelas-desain");

    const bySearch = await repo().browse({ search: "bimbel", category: "", limit: 24 });
    expect(bySearch.map((c) => c.slug).join(",")).toBe("bimbel-sbmptn");

    const all = await repo().browse({ search: "", category: "", limit: 24 });
    expect(all.length).toBe(2);
  });

  it("browse reports a member count per row, so the grid needs no second query", async () => {
    const ownerId = await seedUser("wildan");
    const joinerId = await seedUser("rina");
    const created = await repo().create({ ownerId, slug: "kelas-desain", name: "Kelas Desain", category: "Skill Digital", description: null });
    await repo().join(created.id, joinerId);

    const rows = await repo().browse({ search: "", category: "", limit: 24 });
    expect(rows.map((r) => `${r.slug}:${r.memberCount}`).join(",")).toBe("kelas-desain:2");
  });
});
