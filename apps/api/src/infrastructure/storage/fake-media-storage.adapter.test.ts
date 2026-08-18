import { describe, expect, it } from "bun:test";
import { FakeMediaStorageAdapter } from "./fake-media-storage.adapter";

describe("FakeMediaStorageAdapter", () => {
  it("returns the bytes it was given, per variant", async () => {
    const storage = new FakeMediaStorageAdapter();
    await storage.put("m1", "full", new Uint8Array([1, 2, 3]));
    await storage.put("m1", "thumb", new Uint8Array([9]));

    expect((await storage.get("m1", "full"))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect((await storage.get("m1", "thumb"))?.bytes).toEqual(new Uint8Array([9]));
  });

  it("answers null for an object that was never stored", async () => {
    expect(await new FakeMediaStorageAdapter().get("nope", "full")).toBe(null);
  });

  it("remove takes both variants, and removing twice is not an error", async () => {
    const storage = new FakeMediaStorageAdapter();
    await storage.put("m1", "full", new Uint8Array([1]));
    await storage.put("m1", "thumb", new Uint8Array([2]));

    await storage.remove("m1");
    await storage.remove("m1");

    expect(await storage.get("m1", "full")).toBe(null);
    expect(await storage.get("m1", "thumb")).toBe(null);
  });
});
