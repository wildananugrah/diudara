import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { XENDIT_ACCOUNT_PROVISIONING } from "../../domain/payment-account";
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

  it("claims the column with the sentinel, then replaces it with the real id", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra@example.com" });
    expect(created.xenditAccountId).toBeNull();

    expect(await repository.beginXenditAccountProvisioning(created.id)).toBe(true);
    // The intermediate state is observable, which is the point: StartCheckout
    // reads this column and must refuse this value.
    expect((await repository.findById(created.id))?.xenditAccountId).toBe(
      XENDIT_ACCOUNT_PROVISIONING
    );

    expect(await repository.finishXenditAccountProvisioning(created.id, "xnd-acct-123")).toBe(
      true
    );
    expect((await repository.findById(created.id))?.xenditAccountId).toBe("xnd-acct-123");
  });

  /**
   * I4, final whole-branch review. The UPDATE used to be unconditional, so a
   * second caller silently overwrote the first — and this column is what routes
   * member money to a creator, so overwriting it redirects funds. The `is null`
   * predicate is the guard; these tests are what detect its removal.
   */
  it("refuses to claim a column that is already set, and says so", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra2@example.com" });

    expect(await repository.beginXenditAccountProvisioning(created.id)).toBe(true);
    await repository.finishXenditAccountProvisioning(created.id, "xnd-acct-first");

    expect(await repository.beginXenditAccountProvisioning(created.id)).toBe(false);
    expect((await repository.findById(created.id))?.xenditAccountId).toBe("xnd-acct-first");
  });

  it("refuses to claim a column another caller is already provisioning", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra2b@example.com" });

    expect(await repository.beginXenditAccountProvisioning(created.id)).toBe(true);
    expect(await repository.beginXenditAccountProvisioning(created.id)).toBe(false);
  });

  it("refuses to finish a claim it does not hold", async () => {
    // The predicate is `= sentinel`, so this can only ever replace OUR claim. An
    // unconditional write here would silently redirect a connected creator's funds.
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra2c@example.com" });

    expect(await repository.finishXenditAccountProvisioning(created.id, "xnd-acct-x")).toBe(
      false
    );
    expect((await repository.findById(created.id))?.xenditAccountId).toBeNull();

    await repository.beginXenditAccountProvisioning(created.id);
    await repository.finishXenditAccountProvisioning(created.id, "xnd-acct-real");
    expect(await repository.finishXenditAccountProvisioning(created.id, "xnd-acct-other")).toBe(
      false
    );
    expect((await repository.findById(created.id))?.xenditAccountId).toBe("xnd-acct-real");
  });

  it("releases a claim it holds, and only a claim", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra2d@example.com" });

    // Nothing to release yet.
    expect(await repository.abandonXenditAccountProvisioning(created.id)).toBe(false);

    await repository.beginXenditAccountProvisioning(created.id);
    expect(await repository.abandonXenditAccountProvisioning(created.id)).toBe(true);
    expect((await repository.findById(created.id))?.xenditAccountId).toBeNull();

    // A CONNECTED creator must never be reset to null by this.
    await repository.beginXenditAccountProvisioning(created.id);
    await repository.finishXenditAccountProvisioning(created.id, "xnd-acct-connected");
    expect(await repository.abandonXenditAccountProvisioning(created.id)).toBe(false);
    expect((await repository.findById(created.id))?.xenditAccountId).toBe("xnd-acct-connected");
  });

  it("lets exactly ONE of several concurrent writers claim the column", async () => {
    const repository = new DrizzleCreatorRepository(db);
    const created = await repository.create({ name: "Hendra", email: "hendra3@example.com" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.beginXenditAccountProvisioning(created.id))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repository.findById(created.id))?.xenditAccountId).toBe(
      XENDIT_ACCOUNT_PROVISIONING
    );
  });
});
