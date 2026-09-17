import { describe, expect, test } from "bun:test";
import { newStreamKey, parseStreamPath, streamPathFor, STREAM_NAMESPACE } from "./streamPath.ts";

describe("parseStreamPath", () => {
  test("reads the key out of a path MediaMTX actually sent", () => {
    // Captured verbatim from a real RTMP publish against this deployment.
    expect(parseStreamPath("c/stage0testkey")).toBe("stage0testkey");
    expect(parseStreamPath("c/aB3-_xY9zQw1")).toBe("aB3-_xY9zQw1");
  });

  test("refuses another namespace", () => {
    // The hooks are configured under `all_others`, so they fire for paths that
    // have nothing to do with us. Those must not be mistaken for a session.
    expect(parseStreamPath("u/somekey12345")).toBeNull();
    expect(parseStreamPath("live/somekey12345")).toBeNull();
    expect(parseStreamPath("somekey12345")).toBeNull();
  });

  test("refuses a path that is not exactly namespace/key", () => {
    expect(parseStreamPath("c/key12345/extra")).toBeNull();
    expect(parseStreamPath("c/")).toBeNull();
    expect(parseStreamPath("/c/key12345")).toBeNull();
    expect(parseStreamPath("c")).toBeNull();
  });

  test("refuses a key we could never have issued", () => {
    expect(parseStreamPath("c/short")).toBeNull();            // under 8 chars
    expect(parseStreamPath(`c/${"x".repeat(65)}`)).toBeNull(); // over 64
    expect(parseStreamPath("c/has spaces!")).toBeNull();
    expect(parseStreamPath("c/../../etc/passwd")).toBeNull();
  });

  test("refuses empty input", () => {
    for (const raw of ["", "   ", null, undefined]) expect(parseStreamPath(raw)).toBeNull();
  });

  test("round-trips with streamPathFor", () => {
    const key = "abc123XYZ_-";
    expect(parseStreamPath(streamPathFor(key))).toBe(key);
    expect(streamPathFor(key)).toBe(`${STREAM_NAMESPACE}/${key}`);
  });
});

describe("newStreamKey", () => {
  test("mints a key this deployment accepts back", () => {
    const key = newStreamKey();
    expect(parseStreamPath(streamPathFor(key))).toBe(key);
  });

  test("is unguessable — RTMP :1935 is public, so the key IS the credential", () => {
    // The seeded "bimbel-sbmptn-live" was guessable from the community slug,
    // which on a port the internet actively scans is a broadcast takeover.
    const keys = new Set(Array.from({ length: 1000 }, newStreamKey));
    expect(keys.size).toBe(1000);
    expect(newStreamKey().length).toBeGreaterThanOrEqual(22); // ≥128 bits, base64url
  });
});
