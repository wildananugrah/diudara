import type { StreamingProviderPort } from "../../application/ports/streaming-provider.port";

/** MediaMTX's default RTMP ingest port (infra/mediamtx.yml, Task 6). */
const RTMP_PORT = 1935;

/**
 * !!! UNVERIFIED AGAINST A LIVE MEDIAMTX !!!
 *
 * Written from MediaMTX's published documentation without a running
 * instance — Task 6 stands one up in `infra/docker-compose.yml`, and Task
 * 9's end-to-end pass (`ffmpeg` publishing a test pattern, watched back
 * through `hls.js`) is what actually proves this against a real server.
 * Exercise it there before trusting a creator's OBS session to it, then
 * delete this warning.
 *
 * The one exception is `whipUrl` (Task 2): that shape — a separate `/whip/`
 * nginx prefix, not nested under `/live/` — WAS proven against a running
 * MediaMTX and a real publish before this adapter was written. See
 * `createSession`'s own docstring below.
 *
 * DELIBERATELY THIN, and that is not an oversight: MediaMTX's
 * `authMethod: http` (see `infra/mediamtx.yml`) asks OUR API to authorise
 * every publish and every read (Task 4), so it accepts a publish to ANY
 * path our webhook allows. There is no "register this stream with the
 * provider" call to make, and no session, credential or resource is ever
 * created AT MediaMTX by this class — inventing an API call here would be
 * ceremony over a server that does not require one. "Creating a session"
 * is therefore pure URL construction: two strings built from configuration
 * and the key the caller already minted (`newStreamKey`, in the port
 * module). A future reader expecting a `fetch` in this file and finding
 * none should read this paragraph rather than assume the adapter is
 * unfinished.
 *
 * Neither constructor argument is a secret, so unlike
 * `XenditPaymentAdapter` this class has nothing that must stay out of an
 * error message — there are no error paths at all, since URL string
 * concatenation cannot fail.
 */
export class MediaMtxAdapter implements StreamingProviderPort {
  private readonly rtmpHost: string;
  private readonly hlsBaseUrl: string;
  private readonly whipBaseUrl: string;

  constructor(config: { rtmpHost: string; hlsBaseUrl: string; whipBaseUrl: string }) {
    this.rtmpHost = config.rtmpHost;
    // Trailing slash stripped so concatenating "/live/<key>/index.m3u8"
    // below never produces a doubled "//" — the same rule
    // `resolveAppBaseUrl` (bootstrap.ts) applies to APP_BASE_URL.
    this.hlsBaseUrl = config.hlsBaseUrl.replace(/\/+$/, "");
    // Same rule, same reason, applied to the WHIP origin: concatenating
    // "/whip/<key>" below must never produce a doubled "//" from a
    // configured value that happens to carry a trailing slash.
    this.whipBaseUrl = config.whipBaseUrl.replace(/\/+$/, "");
  }

  /**
   * `whipUrl` (Task 2) is built as `<whipBaseUrl>/whip/<streamKey>` — a
   * shape verified against a real MediaMTX instance and a real publish (see
   * this repo's Task 1), NOT symmetrical with the `/live/<key>/...` shape
   * `rtmpUrl`/`hlsPlaybackPath` use above. `/whip/` is a deliberately
   * SEPARATE nginx location, not nested under `/live/`: nginx's existing
   * `^~ /live/` prefix match would permanently shadow anything placed
   * beneath it, so the public WHIP path could never live at
   * `/live/<key>/whip`. The session sub-resource MediaMTX hands back after
   * the initial POST (`<whipUrl>/<sessionId>`) is nginx's problem, not
   * this adapter's — nginx rewrites it correctly and nothing here needs to
   * construct it.
   */
  createSession(input: {
    streamKey: string;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string } {
    return {
      rtmpUrl: `rtmp://${this.rtmpHost}:${RTMP_PORT}/live/${input.streamKey}`,
      whipUrl: `${this.whipBaseUrl}/whip/${input.streamKey}`,
      hlsPlaybackPath: `${this.hlsBaseUrl}/live/${input.streamKey}/index.m3u8`,
    };
  }
}
