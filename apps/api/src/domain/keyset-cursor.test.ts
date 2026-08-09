import { describe, expect, it } from "bun:test";
import { decodeKeysetCursor, encodeKeysetCursor } from "./keyset-cursor";

describe("the keyset cursor", () => {
  it("round-trips a timestamp and an id", () => {
    const timestamp = new Date("2026-08-10T04:05:06.789Z");
    const id = "3f1c9e0a-1111-4222-8333-444455556666";

    const decoded = decodeKeysetCursor(encodeKeysetCursor({ timestamp, id }));
    expect(decoded).not.toBeNull();
    expect(decoded!.timestamp.toISOString()).toBe(timestamp.toISOString());
    expect(decoded!.id).toBe(id);
  });

  it("keeps the timestamp readable, so a cursor in a log is diagnosable", () => {
    const cursor = encodeKeysetCursor({
      timestamp: new Date("2026-08-10T04:05:06.789Z"),
      id: "3f1c9e0a-1111-4222-8333-444455556666",
    });
    expect(cursor).toContain("2026-08-10T04:05:06.789Z");
  });

  it("rejects a cursor it did not produce rather than guessing", () => {
    // A malformed cursor must be a 400, not a silently-ignored parameter that
    // restarts the list at page 1 — a "load more" button that quietly loops is worse
    // than one that errors, because nothing tells the reader anything is wrong.
    for (const bad of [
      "",
      "not-a-cursor",
      "2026-08-10T04:05:06.789Z",
      "2026-08-10T04:05:06.789Z|not-a-uuid",
      "not-a-date|3f1c9e0a-1111-4222-8333-444455556666",
      "|",
      // Two separators: an id containing one would be ambiguous, so it is refused
      // rather than parsed as its first two thirds.
      "2026-08-10T04:05:06.789Z|3f1c9e0a-1111-4222-8333-444455556666|extra",
    ]) {
      expect(decodeKeysetCursor(bad)).toBeNull();
    }
  });

  it("rejects a timestamp that parses but is not the canonical rendering", () => {
    // `new Date("2026")` is a valid Date. Accepting it would make two different
    // strings mean the same page while looking like different cursors.
    expect(decodeKeysetCursor("2026|3f1c9e0a-1111-4222-8333-444455556666")).toBeNull();
    expect(
      decodeKeysetCursor("2026-08-10T04:05:06Z|3f1c9e0a-1111-4222-8333-444455556666")
    ).toBeNull();
  });
});
