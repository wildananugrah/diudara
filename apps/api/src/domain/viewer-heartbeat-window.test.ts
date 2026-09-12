import { describe, expect, it } from "bun:test";
import { VIEWER_HEARTBEAT_WINDOW_MS } from "./viewer-heartbeat-window";

describe("VIEWER_HEARTBEAT_WINDOW_MS", () => {
  it("is 20 seconds — long enough to survive a normal HLS reload gap", () => {
    expect(VIEWER_HEARTBEAT_WINDOW_MS).toBe(20_000);
  });
});
