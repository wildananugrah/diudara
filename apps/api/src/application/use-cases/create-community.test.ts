import { describe, expect, it } from "bun:test";
import { CreateCommunity } from "./create-community";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

function fakeRepository(existingSlugs: string[] = []) {
  const rows: CommunityRecord[] = [];
  const slugs = new Set(existingSlugs);

  const repository: CommunityRepositoryPort = {
    async create(input) {
      const row: CommunityRecord = {
        id: `community-${rows.length + 1}`,
        creatorId: input.creatorId,
        name: input.name,
        slug: input.slug,
        niche: input.niche ?? null,
        status: "active",
        createdAt: new Date(),
      };
      rows.push(row);
      slugs.add(row.slug);
      return row;
    },
    async findByIdForCreator(id, creatorId) {
      return rows.find((r) => r.id === id && r.creatorId === creatorId) ?? null;
    },
    async listByCreator(creatorId) {
      return rows.filter((r) => r.creatorId === creatorId);
    },
    async slugExists(slug) {
      return slugs.has(slug);
    },
    async update(id, creatorId, patch) {
      const row = rows.find((r) => r.id === id && r.creatorId === creatorId);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };

  return { repository, rows };
}

describe("CreateCommunity", () => {
  it("derives a slug from the name", async () => {
    const { repository } = fakeRepository();
    const useCase = new CreateCommunity(repository);

    const created = await useCase.execute({
      creatorId: "creator-1",
      name: "Kelas Bimbel Budi",
    });

    expect(created.slug).toBe("kelas-bimbel-budi");
  });

  it("appends a suffix when the derived slug is taken", async () => {
    const { repository } = fakeRepository(["kelas-bimbel-budi"]);
    const useCase = new CreateCommunity(repository);

    const created = await useCase.execute({
      creatorId: "creator-1",
      name: "Kelas Bimbel Budi",
    });

    expect(created.slug).toBe("kelas-bimbel-budi-2");
  });

  it("assigns the community to the calling creator", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = new CreateCommunity(repository);

    await useCase.execute({ creatorId: "creator-7", name: "Kelas" });

    expect(rows[0].creatorId).toBe("creator-7");
  });
});
