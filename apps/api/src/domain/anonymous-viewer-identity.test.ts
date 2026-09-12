import { describe, expect, it } from "bun:test";
import { anonymousViewerIdentity } from "./anonymous-viewer-identity";

describe("anonymousViewerIdentity", () => {
  it("hashes the same ip and user agent to the same identity", () => {
    const a = anonymousViewerIdentity("203.0.113.9", "Mozilla/5.0");
    const b = anonymousViewerIdentity("203.0.113.9", "Mozilla/5.0");
    expect(a).toBe(b);
  });

  it("hashes a different ip to a different identity", () => {
    const a = anonymousViewerIdentity("203.0.113.9", "Mozilla/5.0");
    const b = anonymousViewerIdentity("203.0.113.10", "Mozilla/5.0");
    expect(a).not.toBe(b);
  });

  it("hashes a different user agent to a different identity", () => {
    const a = anonymousViewerIdentity("203.0.113.9", "Mozilla/5.0");
    const b = anonymousViewerIdentity("203.0.113.9", "curl/8.0");
    expect(a).not.toBe(b);
  });

  it("is hex, and short enough for the varchar(64) column", () => {
    const identity = anonymousViewerIdentity("203.0.113.9", "Mozilla/5.0");
    expect(identity).toMatch(/^[0-9a-f]+$/);
    expect(identity.length).toBeLessThanOrEqual(64);
  });
});
