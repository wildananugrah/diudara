import { describe, expect, it } from "bun:test";
import { RecordStreamViewerHeartbeat } from "./record-stream-viewer-heartbeat";
import type { StreamViewerRepositoryPort } from "../ports/stream-viewer-repository.port";

class FakeStreamViewers implements StreamViewerRepositoryPort {
  calls: Array<{ streamId: string; identity: string; now: Date }> = [];

  async heartbeat(streamId: string, identity: string, now: Date): Promise<void> {
    this.calls.push({ streamId, identity, now });
  }
  async countRecentViewers(): Promise<Map<string, number>> {
    throw new Error("not used in these tests");
  }
  async deleteOlderThan(): Promise<number> {
    throw new Error("not used in these tests");
  }
}

describe("RecordStreamViewerHeartbeat", () => {
  it("forwards straight to the port", async () => {
    const streamViewers = new FakeStreamViewers();
    const useCase = new RecordStreamViewerHeartbeat(streamViewers);
    const now = new Date("2026-09-12T10:00:00.000Z");

    await useCase.execute({ streamId: "stream-1", identity: "viewer-1", now });

    expect(streamViewers.calls).toEqual([{ streamId: "stream-1", identity: "viewer-1", now }]);
  });
});
