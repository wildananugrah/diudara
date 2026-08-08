import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { webhookEvents } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleWebhookEventRepository } from "./drizzle-webhook-event.repository";

beforeEach(resetDatabase);

const repo = new DrizzleWebhookEventRepository(db);

function event(providerEventId: string) {
  return {
    provider: "xendit",
    providerEventId,
    eventType: "invoice.paid",
    payload: { id: "inv_1", status: "PAID" },
  };
}

describe("DrizzleWebhookEventRepository.recordIfNew", () => {
  it("returns true the first time an event id is seen", async () => {
    expect(await repo.recordIfNew(event("evt-1"))).toBe(true);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("xendit");
    expect(rows[0].providerEventId).toBe("evt-1");
    expect(rows[0].eventType).toBe("invoice.paid");
    expect(rows[0].payload).toEqual({ id: "inv_1", status: "PAID" });
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it("returns false for a replay and writes no second row", async () => {
    await repo.recordIfNew(event("evt-1"));

    expect(await repo.recordIfNew(event("evt-1"))).toBe(false);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("keeps distinct event ids independent", async () => {
    expect(await repo.recordIfNew(event("evt-1"))).toBe(true);
    expect(await repo.recordIfNew(event("evt-2"))).toBe(true);
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
  });

  it("lets the DATABASE arbitrate a concurrent race — exactly one caller wins", async () => {
    // A check-then-insert pre-check would let both callers pass the check and
    // one of them would then 500 on the unique violation. Phase 2 shipped that
    // shape twice; `onConflictDoNothing` is what makes this deterministic.
    const results = await Promise.all([
      repo.recordIfNew(event("evt-race")),
      repo.recordIfNew(event("evt-race")),
      repo.recordIfNew(event("evt-race")),
      repo.recordIfNew(event("evt-race")),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(webhookEvents)).toHaveLength(1);
  });

  it("does not swallow paid and expired for the same invoice when keys differ", async () => {
    // The provider_event_id must be per-DELIVERY. This test pins the repository
    // half of that: two different keys are two different rows, whatever they
    // were derived from.
    expect(await repo.recordIfNew({ ...event("inv_1:PAID"), eventType: "invoice.paid" })).toBe(
      true
    );
    expect(
      await repo.recordIfNew({ ...event("inv_1:EXPIRED"), eventType: "invoice.expired" })
    ).toBe(true);
    expect(await db.select().from(webhookEvents)).toHaveLength(2);
  });
});
