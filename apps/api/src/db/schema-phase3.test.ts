import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { webhookEvents } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("phase 3 schema", () => {
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
