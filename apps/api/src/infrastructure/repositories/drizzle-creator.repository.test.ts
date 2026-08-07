import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleCreatorRepository } from "./drizzle-creator.repository";

beforeEach(resetDatabase);

describe("DrizzleCreatorRepository", () => {
  it("creates a creator and finds it by id and email", async () => {
    const repository = new DrizzleCreatorRepository(db);

    const created = await repository.create({
      name: "Dewi",
      whatsappNumber: "+6281333333333",
      email: "dewi@example.com",
    });

    const byId = await repository.findById(created.id);
    const byEmail = await repository.findByEmail("dewi@example.com");

    expect(byId?.name).toBe("Dewi");
    expect(byEmail?.id).toBe(created.id);
  });

  it("returns null when a creator is not found", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const result = await repository.findById("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});
