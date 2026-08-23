import { describe, expect, it } from "bun:test";
import { FakeStreamingAdapter } from "./fake-streaming.adapter";

/**
 * Retire-telegram Task 7 narrowed `StreamNamespace` to `"u"` alone, so the
 * community half of this file — a whole second `describe` asserting the
 * `live/<key>` and bare `/whip/<key>` shapes, plus a "the two namespaces
 * never collide" case — went with the namespace it exercised. What survives
 * is every assertion that was ever about THIS adapter rather than about
 * having two worlds, re-pointed at the one namespace left.
 *
 * Every assertion below is a literal string, never the constant it checks:
 * these paths must match `infra/nginx/live-hls.conf.template`'s `^~ /u/` and
 * `^~ /whip/u/` locations exactly, and no test in this repository can
 * exercise that file.
 */
describe("FakeStreamingAdapter", () => {
  it("returns an rtmpUrl, whipUrl and hlsPlaybackPath containing the given streamKey", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.rtmpUrl).toContain("abc123");
    expect(session.whipUrl).toContain("abc123");
    expect(session.hlsPlaybackPath).toContain("abc123");
  });

  it("records every call so a test can assert what was asked for", () => {
    const adapter = new FakeStreamingAdapter();
    adapter.createSession({ streamKey: "key-a", namespace: "u" });
    adapter.createSession({ streamKey: "key-b", namespace: "u" });
    expect(adapter.sessions).toEqual([
      { streamKey: "key-a", namespace: "u" },
      { streamKey: "key-b", namespace: "u" },
    ]);
  });

  it("gives two different stream keys two different sessions", () => {
    const adapter = new FakeStreamingAdapter();
    const a = adapter.createSession({ streamKey: "key-a", namespace: "u" });
    const b = adapter.createSession({ streamKey: "key-b", namespace: "u" });
    expect(a.rtmpUrl).not.toBe(b.rtmpUrl);
    expect(a.whipUrl).not.toBe(b.whipUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });

  it("builds an rtmpUrl under /u/<streamKey>", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.rtmpUrl).toBe("rtmp://fake-mediamtx.local:1935/u/abc123");
  });

  /**
   * Final whole-branch review, minor: an earlier version inserted an extra
   * `/hls` segment nothing in `MediaMtxAdapter` — or the nginx read location
   * it must match — ever produces. Locking in the exact shape rather than the
   * looser `.toContain` checks above.
   */
  it("builds an hlsPlaybackPath shaped exactly like MediaMtxAdapter's own — no extra /hls segment", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.hlsPlaybackPath).toBe("https://fake-mediamtx.local/u/abc123/index.m3u8");
  });

  /**
   * Task 2, same discipline as the HLS test above: a fake that drifts from
   * its real counterpart's shape is how integration bugs hide. `whipUrl` is
   * `<base>/whip/u/<key>` — a `/whip/` prefix of its own, not nested under
   * the read prefix, matching `MediaMtxAdapter`'s verified construction.
   */
  it("builds a whipUrl shaped exactly like MediaMtxAdapter's own — <base>/whip/u/<key>", () => {
    const adapter = new FakeStreamingAdapter();
    const session = adapter.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.whipUrl).toBe("https://fake-mediamtx.local/whip/u/abc123");
  });
});
