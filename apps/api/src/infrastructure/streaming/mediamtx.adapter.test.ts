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
    const session = adapter().createSession({ streamKey: "abc123", namespace: "live" });
    expect(session.rtmpUrl).toBe("rtmp://stream.example.com:1935/live/abc123");
  });

  it("builds an HLS playback path from the configured base URL", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "live" });
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
    const session = withTrailingSlash.createSession({ streamKey: "abc123", namespace: "live" });
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
    const session = adapter().createSession({ streamKey: "abc123", namespace: "live" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/abc123");
  });

  it("strips a trailing slash from MEDIAMTX_WHIP_BASE_URL so the path never doubles up", () => {
    const withTrailingSlash = new MediaMtxAdapter({
      rtmpHost: "stream.example.com",
      hlsBaseUrl: "https://stream.example.com/hls",
      whipBaseUrl: "https://stream.example.com/",
    });
    const session = withTrailingSlash.createSession({ streamKey: "abc123", namespace: "live" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/abc123");
  });

  it("gives two different stream keys two different sessions", () => {
    const a = adapter().createSession({ streamKey: "key-a", namespace: "live" });
    const b = adapter().createSession({ streamKey: "key-b", namespace: "live" });
    expect(a.rtmpUrl).not.toBe(b.rtmpUrl);
    expect(a.whipUrl).not.toBe(b.whipUrl);
    expect(a.hlsPlaybackPath).not.toBe(b.hlsPlaybackPath);
  });

  it("makes no network call — createSession is synchronous", () => {
    // If this returned a Promise, awaiting a non-promise below would still
    // pass — the real assertion is the type: TypeScript would refuse to
    // compile `.rtmpUrl` off a Promise without an await, so this line only
    // typechecks if createSession genuinely returns the object directly.
    const session = adapter().createSession({ streamKey: "sync-check", namespace: "live" });
    expect(session.rtmpUrl).toContain("sync-check");
  });
});

/**
 * Task 4. `u` is Phase 7's namespace for a person's own broadcast (design
 * spec §6, `parseStreamPath`'s `NAMESPACES`). Before this task nothing in
 * this codebase CONSTRUCTED such a path — the adapter hard-coded `live/`,
 * so a real user publish arrived at `AuthoriseStream` parsed as the
 * community world and never reached the user branch at all.
 *
 * Every assertion below is a literal string, never the constant it checks:
 * these paths must match `infra/nginx/live-hls.conf.template`'s `^~ /u/`
 * and `^~ /whip/u/` locations exactly, and no test in this repository can
 * exercise that file.
 */
describe("MediaMtxAdapter — the user namespace", () => {
  it("builds an RTMP URL under /u/<streamKey> when the namespace is the user world", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.rtmpUrl).toBe("rtmp://stream.example.com:1935/u/abc123");
  });

  it("builds an HLS playback path under /u/<streamKey> when the namespace is the user world", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.hlsPlaybackPath).toBe("https://stream.example.com/hls/u/abc123/index.m3u8");
  });

  /**
   * ASYMMETRIC ON PURPOSE, and this is the one judgement call in this file.
   * The community WHIP url is `<base>/whip/<key>` with no namespace segment
   * at all — a shape verified against a real MediaMTX and a real publish,
   * and one this task is forbidden from changing by a byte. So the user
   * world gets its namespace as an EXTRA segment (`/whip/u/<key>`) rather
   * than the community world losing its bare shape. nginx's longest-prefix
   * rule is what keeps the two apart: `^~ /whip/u/` is a strictly longer
   * literal prefix than `^~ /whip/`, so it wins for every user request
   * regardless of source order, and a 32-hex stream key can never itself be
   * the single character `u`.
   */
  it("builds a public WHIP URL as <whipBaseUrl>/whip/u/<streamKey> for the user world", () => {
    const session = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(session.whipUrl).toBe("https://stream.example.com/whip/u/abc123");
  });

  it("the two namespaces never produce the same URLs for the same key", () => {
    const community = adapter().createSession({ streamKey: "abc123", namespace: "live" });
    const user = adapter().createSession({ streamKey: "abc123", namespace: "u" });
    expect(community.rtmpUrl).not.toBe(user.rtmpUrl);
    expect(community.whipUrl).not.toBe(user.whipUrl);
    expect(community.hlsPlaybackPath).not.toBe(user.hlsPlaybackPath);
  });
});
