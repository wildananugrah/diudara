import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { creators, webhookEvents } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("phase 3 schema", () => {
  it("stores a creator without a payment account by default", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Budi", email: "budi@example.com" })
      .returning();
    expect(creator.xenditAccountId).toBeNull();
  });

  it("rejects a duplicate provider event id", async () => {
    await db.insert(webhookEvents).values({
      provider: "xendit",
      providerEventId: "evt-1",
      eventType: "invoice.paid",
      payload: { any: "thing" },
    });

    let failed = false;
    try {
      await db.insert(webhookEvents).values({
        provider: "xendit",
        providerEventId: "evt-1",
        eventType: "invoice.paid",
        payload: { any: "thing" },
      });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect((await db.select().from(webhookEvents)).length).toBe(1);
  });
});
