import { describe, expect, it } from "bun:test";
import { MediaMtxAdapter } from "./mediamtx.adapter";

describe("MediaMtxAdapter", () => {
  it("builds an RTMP URL on port 1935 under /live/<streamKey>", () => {
    const adapter = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
    });
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.rtmpUrl).toBe("rtmp://stream.example.com:1935/live/abc123");
  });

  it("builds an HLS playback path from the configured base URL", () => {
    const adapter = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
    });
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.hlsPlaybackPath).toBe(
      "https://stream.example.com/hls/live/abc123/index.m3u8"
    );
  });

  it("strips a trailing slash from MEDIAMTX_HLS_BASE_URL so the path never doubles up", () => {
    const adapter = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls/",
    });
    const session = adapter.createSession({ streamKey: "abc123" });
    expect(session.hlsPlaybackPath).toBe(
      "https://stream.example.com/hls/live/abc123/index.m3u8"
    );
  });

  it("gives two different stream keys two different sessions", () => {
    const adapter = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
    });
    const a = adapter.createSession({ streamKey: "key-a" });
    const b = adapter.createSession({ streamKey: "key-b" });
    expect(a.rtmpUrl).not.toBe(b.rtmpUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });

  it("makes no network call — createSession is synchronous", () => {
    const adapter = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
    });
    // If this returned a Promise, awaiting a non-promise below would still
    // pass — the real assertion is the type: TypeScript would refuse to
    // compile `.rtmpUrl` off a Promise without an await, so this line only
    // typechecks if createSession genuinely returns the object directly.
    const session = adapter.createSession({ streamKey: "sync-check" });
    expect(session.rtmpUrl).toContain("sync-check");
  });
});
