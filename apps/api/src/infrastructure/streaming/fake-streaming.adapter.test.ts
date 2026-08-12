import { describe, expect, it } from "bun:test";
import { FakeStreamingAdapter } from "./fake-streaming.adapter";

describe("FakeStreamingAdapter", () => {
  it("returns an rtmpUrl, whipUrl and hlsPlaybackPath containing the given streamKey", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.rtmpUrl).toContain("abc123");
    expect(session.whipUrl).toContain("abc123");
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
    expect(a.whipUrl).not.toBe(b.whipUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });

  /**
   * Final whole-branch review, minor: an earlier version inserted an extra
   * `/hls` segment nothing in `MediaMtxAdapter` — or the nginx `/live/...`
   * location it must match — ever produces. Locking in the exact shape
   * rather than the looser `.toContain` checks above.
   */
  it("builds an hlsPlaybackPath shaped exactly like MediaMtxAdapter's own — no extra /hls segment", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.hlsPlaybackPath).toBe("https://fake-mediamtx.local/live/abc123/index.m3u8");
  });

  /**
   * Task 2, same discipline as the HLS test above: a fake that drifts from
   * its real counterpart's shape is how integration bugs hide. `whipUrl` is
   * `<base>/whip/<key>` with NOTHING else inserted — no `/live/` segment,
   * matching `MediaMtxAdapter`'s own verified (Task 1) construction exactly.
   */
  it("builds a whipUrl shaped exactly like MediaMtxAdapter's own — <base>/whip/<key>, not nested under /live/", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.whipUrl).toBe("https://fake-mediamtx.local/whip/abc123");
  });
});
