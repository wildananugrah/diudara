import { describe, expect, it } from "bun:test";
import { CreateCommunity } from "./create-community";
import { ConflictError } from "../errors";
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
        // Mirrors DrizzleCommunityRepository: omitted input defaults to
        // "paid", the same as the database column's own DEFAULT.
        accessMode: input.accessMode ?? "paid",
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
    async findBySlug() {
      throw new Error("not used: CreateCommunity is an authenticated use-case");
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

  describe("payments disabled", () => {
    it("refuses accessMode: paid with the exact ConflictError message", async () => {
      const { repository } = fakeRepository();
      const useCase = new CreateCommunity(repository, { paymentsEnabled: false });

      await expect(
        useCase.execute({ creatorId: "creator-1", name: "Kelas Budi", accessMode: "paid" })
      ).rejects.toThrow(
        "pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat"
      );
    });

    it("refuses accessMode: paid as a ConflictError, specifically", async () => {
      const { repository } = fakeRepository();
      const useCase = new CreateCommunity(repository, { paymentsEnabled: false });

      await expect(
        useCase.execute({ creatorId: "creator-1", name: "Kelas Budi", accessMode: "paid" })
      ).rejects.toBeInstanceOf(ConflictError);
    });

    // Missing accessMode is treated the same as "paid": the database column
    // defaults to "paid", so a silent "request" fallback here would hand out
    // free memberships nobody asked for.
    it("also refuses when accessMode is omitted, since the database defaults it to paid", async () => {
      const { repository } = fakeRepository();
      const useCase = new CreateCommunity(repository, { paymentsEnabled: false });

      await expect(
        useCase.execute({ creatorId: "creator-1", name: "Kelas Budi" })
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("always allows accessMode: request, even with payments disabled", async () => {
      const { repository, rows } = fakeRepository();
      const useCase = new CreateCommunity(repository, { paymentsEnabled: false });

      const created = await useCase.execute({
        creatorId: "creator-1",
        name: "Kelas Budi",
        accessMode: "request",
      });

      expect(created.slug).toBe("kelas-budi");
      expect(created.accessMode).toBe("request");
      expect(rows).toHaveLength(1);
    });
  });

  describe("payments enabled", () => {
    it("allows accessMode: paid, and actually forwards it to the repository", async () => {
      const { repository, rows } = fakeRepository();
      const useCase = new CreateCommunity(repository, { paymentsEnabled: true });

      const created = await useCase.execute({
        creatorId: "creator-1",
        name: "Kelas Budi",
        accessMode: "paid",
      });

      expect(created.accessMode).toBe("paid");
      expect(rows).toHaveLength(1);
      expect(rows[0].accessMode).toBe("paid");
    });

    // The default for a caller (like every test above this describe block)
    // that never passes the options object at all — existing behaviour must
    // not change just because CreateCommunity now takes a second constructor
    // argument.
    it("defaults to enabled when the options argument is omitted entirely", async () => {
      const { repository, rows } = fakeRepository();
      const useCase = new CreateCommunity(repository);

      await useCase.execute({ creatorId: "creator-1", name: "Kelas Budi", accessMode: "paid" });

      expect(rows).toHaveLength(1);
    });
  });
});
