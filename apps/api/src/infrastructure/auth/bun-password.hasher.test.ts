import { describe, expect, it } from "bun:test";
import { BunPasswordHasher } from "./bun-password.hasher";

describe("BunPasswordHasher", () => {
  it("verifies a correct password against its hash", async () => {
    const hasher = new BunPasswordHasher();
    const hash = await hasher.hash("supersecret123");
    expect(await hasher.verify("supersecret123", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hasher = new BunPasswordHasher();
    const hash = await hasher.hash("supersecret123");
    expect(await hasher.verify("wrong-password", hash)).toBe(false);
  });

  it("does not store the plaintext in the hash", async () => {
    const hasher = new BunPasswordHasher();
    const hash = await hasher.hash("supersecret123");
    expect(hash).not.toContain("supersecret123");
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    const hasher = new BunPasswordHasher();
    expect(await hasher.verify("supersecret123", "not-a-real-hash")).toBe(false);
  });
});
