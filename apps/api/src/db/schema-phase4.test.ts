import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { outbox } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("phase 4 schema", () => {
  it("defaults an outbox row to pending with no attempts", async () => {
    const [row] = await db
      .insert(outbox)
      .values({ eventType: "grant_access", payload: { subscriptionId: "s1" } })
      .returning();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });
});
