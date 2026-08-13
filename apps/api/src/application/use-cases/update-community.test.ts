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
    async findBySlug() {
      throw new Error("not used: UpdateCommunity is an authenticated use-case");
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
    accessMode: "paid",
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

  describe("payments disabled", () => {
    it("refuses accessMode: paid with the exact ConflictError message", async () => {
      const { repository } = fakeRepository([community()]);
      const useCase = new UpdateCommunity(repository, { paymentsEnabled: false });

      await expect(
        useCase.execute({
          communityId: "community-1",
          creatorId: "creator-1",
          patch: { accessMode: "paid" },
        })
      ).rejects.toThrow(
        "pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat"
      );
    });

    it("refuses accessMode: paid as a ConflictError, specifically", async () => {
      const { repository } = fakeRepository([community()]);
      const useCase = new UpdateCommunity(repository, { paymentsEnabled: false });

      await expect(
        useCase.execute({
          communityId: "community-1",
          creatorId: "creator-1",
          patch: { accessMode: "paid" },
        })
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("always allows accessMode: request, even with payments disabled", async () => {
      const { repository, rows } = fakeRepository([community()]);
      const useCase = new UpdateCommunity(repository, { paymentsEnabled: false });

      const updated = await useCase.execute({
        communityId: "community-1",
        creatorId: "creator-1",
        patch: { accessMode: "request" },
      });

      expect(updated.accessMode).toBe("request");
      expect(rows).toHaveLength(1);
    });

    // Unlike CreateCommunity, an OMITTED accessMode on a patch means "leave it
    // as it is" — ordinary patch semantics — so a patch that never mentions
    // accessMode at all must not be refused just because payments happen to
    // be disabled on this box.
    it("allows a patch that never touches accessMode at all", async () => {
      const { repository } = fakeRepository([community()]);
      const useCase = new UpdateCommunity(repository, { paymentsEnabled: false });

      const updated = await useCase.execute({
        communityId: "community-1",
        creatorId: "creator-1",
        patch: { name: "Nama Baru" },
      });

      expect(updated.name).toBe("Nama Baru");
    });
  });

  describe("payments enabled", () => {
    it("allows accessMode: paid", async () => {
      const { repository } = fakeRepository([community()]);
      const useCase = new UpdateCommunity(repository, { paymentsEnabled: true });

      const updated = await useCase.execute({
        communityId: "community-1",
        creatorId: "creator-1",
        patch: { accessMode: "paid" },
      });

      expect(updated.accessMode).toBe("paid");
    });

    // The default for a caller (like every test above this describe block)
    // that never passes the options object at all — existing behaviour must
    // not change just because UpdateCommunity now takes a second constructor
    // argument.
    it("defaults to enabled when the options argument is omitted entirely", async () => {
      const { repository } = fakeRepository([community()]);
      const useCase = new UpdateCommunity(repository);

      const updated = await useCase.execute({
        communityId: "community-1",
        creatorId: "creator-1",
        patch: { accessMode: "paid" },
      });

      expect(updated.accessMode).toBe("paid");
    });
  });
});
