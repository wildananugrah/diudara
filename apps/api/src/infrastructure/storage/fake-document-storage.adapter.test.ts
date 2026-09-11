import { describe, expect, test } from "bun:test";
import { FakeDocumentStorageAdapter } from "./fake-document-storage.adapter";

describe("FakeDocumentStorageAdapter", () => {
  test("round-trips the exact bytes it was given", async () => {
    const storage = new FakeDocumentStorageAdapter();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

    await storage.put("doc-1", bytes);

    expect(await storage.get("doc-1")).toEqual(bytes);
  });

  test("answers null for an id it never stored", async () => {
    expect(await new FakeDocumentStorageAdapter().get("missing")).toBeNull();
  });

  test("remove deletes the object, and is idempotent", async () => {
    const storage = new FakeDocumentStorageAdapter();
    await storage.put("doc-1", new Uint8Array([1]));

    await storage.remove("doc-1");
    await storage.remove("doc-1");

    expect(await storage.get("doc-1")).toBeNull();
    expect(storage.size).toBe(0);
  });

  test("two ids never collide", async () => {
    const storage = new FakeDocumentStorageAdapter();
    await storage.put("a", new Uint8Array([1]));
    await storage.put("b", new Uint8Array([2]));

    await storage.remove("a");

    expect(await storage.get("b")).toEqual(new Uint8Array([2]));
  });
});
