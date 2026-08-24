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

/**
 * Retire-telegram Task 7 narrowed `StreamNamespace` to `"u"` alone, so every
 * case here that passed `namespace: "live"` — the whole community half, plus
 * a "the two namespaces never produce the same URLs" case that needed two
 * namespaces to exist — was re-pointed at the one namespace left or dropped
 * with the world it exercised. Nothing about the adapter's construction rules
 * changed; only which segment they are exercised through.
 *
 * `u` is Phase 7's namespace for a person's own broadcast (design spec §6,
 * `parseStreamPath`'s `NAMESPACES`).
 *
 * Every assertion below is a literal string, never the constant it checks:
 * these paths must match `infra/nginx/live-hls.conf.template`'s `^~ /u/` and
 * `^~ /whip/u/` locations exactly, and no test in this repository can
 * exercise that file.
 */
describe("MediaMtxAdapter", () => {
  it("builds an RTMP URL on port 1935 under /u/<streamKey>", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.rtmpUrl).toBe("rtmp://stream.example.com:1935/u/abc123");
  });

  it("builds an HLS playback path from the configured base URL", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.hlsPlaybackPath).toBe("https://stream.example.com/hls/u/abc123/index.m3u8");
  });

  it("strips a trailing slash from MEDIAMTX_HLS_BASE_URL so the path never doubles up", () => {
    const withTrailingSlash = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls/",
      whipBaseUrl: "https://stream.example.com",
    });
    const session = withTrailingSlash.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.hlsPlaybackPath).toBe("https://stream.example.com/hls/u/abc123/index.m3u8");
  });

  /**
   * Task 2. Task 1's own proof (task-1-report.md) confirmed the `/whip/`
   * prefix against a real MediaMTX instance and a real publish through
   * nginx — deliberately NOT nested under the HLS read prefix, and NOT
   * parallel to the HLS path's shape (see the adapter's own docstring for
   * why a `^~` read prefix rules that out). The stream key lands in this URL
   * exactly as it does in `rtmpUrl`.
   */
  it("builds a public WHIP URL as <whipBaseUrl>/whip/u/<streamKey> — the verified nginx shape", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/u/abc123");
  });

  it("strips a trailing slash from MEDIAMTX_WHIP_BASE_URL so the path never doubles up", () => {
    const withTrailingSlash = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
      whipBaseUrl: "https://stream.example.com/",
    });
    const session = withTrailingSlash.createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/u/abc123");
  });

  it("gives two different stream keys two different sessions", () => {
    const a = adapter().createSession({ streamKey: "key-a", namespace: "u" });
    const b = adapter().createSession({ streamKey: "key-b", namespace: "u" });
    expect(a.rtmpUrl).not.toBe(b.rtmpUrl);
    expect(a.whipUrl).not.toBe(b.whipUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });

  it("makes no network call — createSession is synchronous", () => {
    // If this returned a Promise, awaiting a non-promise below would still
    // pass — the real assertion is the type: TypeScript would refuse to
    // compile `.rtmpUrl` off a Promise without an await, so this line only
    // typechecks if createSession genuinely returns the object directly.
    const session = adapter().createSession({ streamKey: "sync-check", namespace: "u" });
    expect(session.rtmpUrl).toContain("sync-check");
  });
});
