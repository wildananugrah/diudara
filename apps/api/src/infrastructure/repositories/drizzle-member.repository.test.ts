import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMemberRepository } from "./drizzle-member.repository";

beforeEach(resetDatabase);

const repo = new DrizzleMemberRepository(db);

describe("DrizzleMemberRepository.findOrCreateByWhatsappNumber", () => {
  it("creates a member, then resolves the same number to the SAME row", async () => {
    const first = await repo.findOrCreateByWhatsappNumber({
      whatsappNumber: "+6281234567890",
      name: "Siti",
    });
    const second = await repo.findOrCreateByWhatsappNumber({
      whatsappNumber: "+6281234567890",
      name: "Siti Typed Differently",
    });

    expect(second.id).toBe(first.id);
    // The stored name is not overwritten by whatever a later checkout typed.
    expect(second.name).toBe("Siti");
  });
});

describe("DrizzleMemberRepository.findById", () => {
  it("returns the member the outbox worker must notify", async () => {
    const created = await repo.findOrCreateByWhatsappNumber({
      whatsappNumber: "+6289999999999",
      name: "Budi",
    });

    const found = await repo.findById(created.id);

    // The WhatsApp number is the whole point of this lookup: it is where the
    // invite link is sent, and the outbox payload carries only ids.
    expect(found?.whatsappNumber).toBe("+6289999999999");
    expect(found?.name).toBe("Budi");
  });

  it("reports an unknown or malformed id as a miss, not an error", async () => {
    expect(await repo.findById("3f1c9e0a-1111-4222-8333-444455556666")).toBeNull();
    // A driver error here would become the outbox row's last_error, carrying the
    // failed statement's bound parameters with it.
    expect(await repo.findById("not-a-uuid")).toBeNull();
  });
});
