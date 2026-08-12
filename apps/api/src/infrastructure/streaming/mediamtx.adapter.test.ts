import { describe, expect, it } from "bun:test";
import { MediaMtxAdapter } from "./mediamtx.adapter";

/** A fully-configured adapter, matching production shape for every test below. */
function adapter() {
  return new MediaMtxAdapter({
    rtmpHost: "stream.example.com",
    hlsBaseUrl: "https://stream.example.com/hls",
    whipBaseUrl: "https://stream.example.com",
  });
}

describe("MediaMtxAdapter", () => {
  it("builds an RTMP URL on port 1935 under /live/<streamKey>", () => {
    const session = adapter().createSession({ streamKey: "abc123" });
    expect(session.rtmpUrl).toBe("rtmp://stream.example.com:1935/live/abc123");
  });

  it("builds an HLS playback path from the configured base URL", () => {
    const session = adapter().createSession({ streamKey: "abc123" });
    expect(session.hlsPlaybackPath).toBe(
      "https://stream.example.com/hls/live/abc123/index.m3u8"
    );
  });

  it("strips a trailing slash from MEDIAMTX_HLS_BASE_URL so the path never doubles up", () => {
    const withTrailingSlash = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls/",
      whipBaseUrl: "https://stream.example.com",
    });
    const session = withTrailingSlash.createSession({ streamKey: "abc123" });
    expect(session.hlsPlaybackPath).toBe(
      "https://stream.example.com/hls/live/abc123/index.m3u8"
    );
  });

  /**
   * Task 2. Task 1's own proof (task-1-report.md) confirmed this EXACT
   * shape against a real MediaMTX instance and a real publish through
   * nginx's `/whip/` location — deliberately NOT nested under `/live/`, and
   * NOT parallel to the HLS path's shape (see the adapter's own docstring
   * for why nginx's `^~ /live/` prefix rules that out). The stream key
   * lands in this URL exactly as it does in `rtmpUrl`.
   */
  it("builds a public WHIP URL as <whipBaseUrl>/whip/<streamKey> — the verified nginx shape, not nested under /live/", () => {
    const session = adapter().createSession({ streamKey: "abc123" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/abc123");
  });

  it("strips a trailing slash from MEDIAMTX_WHIP_BASE_URL so the path never doubles up", () => {
    const withTrailingSlash = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
      whipBaseUrl: "https://stream.example.com/",
    });
    const session = withTrailingSlash.createSession({ streamKey: "abc123" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/abc123");
  });

  it("gives two different stream keys two different sessions", () => {
    const a = adapter().createSession({ streamKey: "key-a" });
    const b = adapter().createSession({ streamKey: "key-b" });
    expect(a.rtmpUrl).not.toBe(b.rtmpUrl);
    expect(a.whipUrl).not.toBe(b.whipUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });

  it("makes no network call — createSession is synchronous", () => {
    // If this returned a Promise, awaiting a non-promise below would still
    // pass — the real assertion is the type: TypeScript would refuse to
    // compile `.rtmpUrl` off a Promise without an await, so this line only
    // typechecks if createSession genuinely returns the object directly.
    const session = adapter().createSession({ streamKey: "sync-check" });
    expect(session.rtmpUrl).toContain("sync-check");
  });
});
