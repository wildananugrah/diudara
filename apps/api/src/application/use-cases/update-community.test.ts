import { describe, expect, it } from "bun:test";
import { UpdateCommunity } from "./update-community";
import { ConflictError, NotFoundError } from "../errors";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

function fakeRepository(seed: CommunityRecord[] = []) {
  const rows = [...seed];
  const repository: CommunityRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByIdForCreator(id, creatorId) {
      return rows.find((r) => r.id === id && r.creatorId === creatorId) ?? null;
    },
    async listByCreator(creatorId) {
      return rows.filter((r) => r.creatorId === creatorId);
    },
    async slugExists(slug) {
      return rows.some((r) => r.slug === slug);
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

function community(overrides: Partial<CommunityRecord> = {}): CommunityRecord {
  return {
    id: "community-1",
    creatorId: "creator-1",
    name: "Kelas Budi",
    slug: "kelas-budi",
    niche: null,
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("UpdateCommunity", () => {
  it("updates a field the caller owns", async () => {
    const { repository } = fakeRepository([community()]);
    const useCase = new UpdateCommunity(repository);

    const updated = await useCase.execute({
      communityId: "community-1",
      creatorId: "creator-1",
      patch: { name: "Kelas Budi Premium" },
    });

    expect(updated.name).toBe("Kelas Budi Premium");
  });

  it("throws NotFoundError when the community belongs to another creator", async () => {
    const { repository } = fakeRepository([community()]);
    const useCase = new UpdateCommunity(repository);

    await expect(
      useCase.execute({
        communityId: "community-1",
        creatorId: "someone-else",
        patch: { name: "Dibajak" },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a slug that another community already uses", async () => {
    const { repository } = fakeRepository([
      community(),
      community({ id: "community-2", slug: "sudah-dipakai" }),
    ]);
    const useCase = new UpdateCommunity(repository);

    await expect(
      useCase.execute({
        communityId: "community-1",
        creatorId: "creator-1",
        patch: { slug: "sudah-dipakai" },
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows re-saving a community's own current slug", async () => {
    const { repository } = fakeRepository([community()]);
    const useCase = new UpdateCommunity(repository);

    const updated = await useCase.execute({
      communityId: "community-1",
      creatorId: "creator-1",
      patch: { slug: "kelas-budi", name: "Nama Baru" },
    });

    expect(updated.slug).toBe("kelas-budi");
    expect(updated.name).toBe("Nama Baru");
  });
});
