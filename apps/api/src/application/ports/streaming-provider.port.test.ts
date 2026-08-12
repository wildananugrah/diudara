import { describe, expect, it } from "bun:test";
import { newStreamKey } from "./streaming-provider.port";

describe("newStreamKey", () => {
  it("returns 32 hex characters (16 bytes from crypto.randomBytes)", () => {
    const key = newStreamKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never repeats across 1000 mints", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      keys.add(newStreamKey());
    }
    expect(keys.size).toBe(1000);
  });
});
