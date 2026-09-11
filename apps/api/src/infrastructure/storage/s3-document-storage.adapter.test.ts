import { describe, expect, test } from "bun:test";
import { S3DocumentStorageAdapter } from "./s3-document-storage.adapter";

const CONFIG = {
  accessKeyId: "placeholder",
  secretAccessKey: "placeholder",
  bucket: "placeholder",
  endpoint: "https://example.invalid",
  region: "id-jkt-1",
};

/**
 * The guard, not the bucket. Every one of these asserts that this adapter
 * REFUSES to touch the network under `bun test` — which is the only behaviour
 * of it this suite can observe, and the one that matters: a route test that
 * accidentally wires the real adapter must fail loudly and instantly rather
 * than open a socket.
 */
describe("S3DocumentStorageAdapter under bun test", () => {
  test("constructing it is allowed — selection tests assert instanceof", () => {
    expect(new S3DocumentStorageAdapter(CONFIG)).toBeInstanceOf(S3DocumentStorageAdapter);
  });

  test.each(["put", "get", "remove"] as const)("%s refuses rather than calling out", async (method) => {
    const adapter = new S3DocumentStorageAdapter(CONFIG);
    const call =
      method === "put"
        ? adapter.put("doc-1", new Uint8Array([1]))
        : method === "get"
          ? adapter.get("doc-1")
          : adapter.remove("doc-1");

    // A STRING match on the method name, never the error object: the message
    // is what points whoever added the offending test at what happened.
    expect(call).rejects.toThrow(`S3DocumentStorageAdapter.${method}()`);
  });
});
