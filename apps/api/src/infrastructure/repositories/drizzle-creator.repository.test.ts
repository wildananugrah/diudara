import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { creators } from "../../db/schema";
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

  // Password hashes must never leave the repository layer (plan-wide constraint:
  // no endpoint may return password_hash). TypeScript can't catch a leak here — a
  // Drizzle row returned as-is structurally satisfies CreatorRecord even with an
  // extra passwordHash field, since excess-property checking only applies to
  // object literals. So this checks the actual runtime key, not just the value.
  it("never exposes passwordHash from create, findById, or findByEmail", async () => {
    const repository = new DrizzleCreatorRepository(db);

    const [seeded] = await db
      .insert(creators)
      .values({
        name: "Farah",
        email: "farah@example.com",
        passwordHash: "$argon2id$fake",
      })
      .returning();

    const created = await repository.create({
      name: "Gilang",
      whatsappNumber: "+6281333444555",
      email: "gilang@example.com",
    });
    const byId = await repository.findById(seeded.id);
    const byEmail = await repository.findByEmail("farah@example.com");

    expect("passwordHash" in created).toBe(false);
    expect(byId).not.toBeNull();
    expect(byEmail).not.toBeNull();
    expect("passwordHash" in (byId as object)).toBe(false);
    expect("passwordHash" in (byEmail as object)).toBe(false);
  });

  it("persists a xendit account id via setXenditAccountId", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra@example.com" });
    expect(created.xenditAccountId).toBeNull();

    await repository.setXenditAccountId(created.id, "xnd-acct-123");

    const updated = await repository.findById(created.id);
    expect(updated?.xenditAccountId).toBe("xnd-acct-123");
  });
});
