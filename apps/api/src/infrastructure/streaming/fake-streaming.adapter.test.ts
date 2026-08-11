import { describe, expect, it } from "bun:test";
import { FakeStreamingAdapter } from "./fake-streaming.adapter";

describe("FakeStreamingAdapter", () => {
  it("returns an rtmpUrl and hlsPlaybackPath containing the given streamKey", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.rtmpUrl).toContain("abc123");
    expect(session.hlsPlaybackPath).toContain("abc123");
  });

  it("records every call so a test can assert what was asked for", () => {
    const adapter = new FakeStreamingAdapter();
    adapter.createSession({ streamKey: "key-a" });
    adapter.createSession({ streamKey: "key-b" });
    expect(adapter.sessions).toEqual([{ streamKey: "key-a" }, { streamKey: "key-b" }]);
  });

  it("gives two different stream keys two different sessions", () => {
    const adapter = new FakeStreamingAdapter();
    const a = adapter.createSession({ streamKey: "key-a" });
    const b = adapter.createSession({ streamKey: "key-b" });
    expect(a.rtmpUrl).not.toBe(b.rtmpUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });
});
