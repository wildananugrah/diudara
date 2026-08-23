import { describe, expect, it } from "bun:test";
import { FakeStreamingAdapter } from "./fake-streaming.adapter";

describe("FakeStreamingAdapter", () => {
  it("returns an rtmpUrl, whipUrl and hlsPlaybackPath containing the given streamKey", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "live" });
    expect(session.rtmpUrl).toContain("abc123");
    expect(session.whipUrl).toContain("abc123");
    expect(session.hlsPlaybackPath).toContain("abc123");
  });

  it("records every call so a test can assert what was asked for", () => {
    const adapter = new FakeStreamingAdapter();
    adapter.createSession({ streamKey: "key-a", namespace: "live" });
    adapter.createSession({ streamKey: "key-b", namespace: "u" });
    expect(adapter.sessions).toEqual([
      { streamKey: "key-a", namespace: "live" },
      { streamKey: "key-b", namespace: "u" },
    ]);
  });

  it("gives two different stream keys two different sessions", () => {
    const adapter = new FakeStreamingAdapter();
    const a = adapter.createSession({ streamKey: "key-a", namespace: "live" });
    const b = adapter.createSession({ streamKey: "key-b", namespace: "live" });
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
    const session = adapter.createSession({ streamKey: "abc123", namespace: "live" });
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
    const session = adapter.createSession({ streamKey: "abc123", namespace: "live" });
    expect(session.whipUrl).toBe("https://fake-mediamtx.local/whip/abc123");
  });
});

/**
 * Task 4, held to the SAME rule the two tests above already state: this fake
 * must match `MediaMtxAdapter`'s construction shape for the user namespace
 * too, byte for byte in structure. A fake that drifts is how integration
 * bugs hide — and here the real adapter's shape is what nginx's `^~ /u/`
 * and `^~ /whip/u/` locations are written against.
 */
describe("FakeStreamingAdapter — the user namespace", () => {
  it("builds an rtmpUrl under /u/<streamKey> for the user world", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.rtmpUrl).toBe("rtmp://fake-mediamtx.local:1935/u/abc123");
  });

  it("builds an hlsPlaybackPath under /u/<streamKey> for the user world", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.hlsPlaybackPath).toBe("https://fake-mediamtx.local/u/abc123/index.m3u8");
  });

  it("builds a whipUrl under /whip/u/<streamKey> for the user world — the extra segment MediaMtxAdapter adds", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.whipUrl).toBe("https://fake-mediamtx.local/whip/u/abc123");
  });
});
