import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "./client";
import { creators, communities, events } from "./schema";
import { resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);

describe("extended schema — event with streaming fields", () => {
  it("creates an event defaulting to status 'scheduled' with nullable streaming fields", async () => {
    const [creator] = await db
      .insert(creators)
      .values({ name: "Sinta", whatsappNumber: "+6281222222222" })
      .returning();
    const [community] = await db
      .insert(communities)
      .values({ creatorId: creator.id, name: "Kelas Sinta" })
      .returning();

    const [event] = await db
      .insert(events)
      .values({ communityId: community.id, title: "Sesi Live Perdana" })
      .returning();

    expect(event.status).toBe("scheduled");
    expect(event.streamKey).toBeNull();
    expect(event.recordingUrl).toBeNull();
  });
});
