import type {
  StreamingProviderPort,
  StreamNamespace,
} from "../../application/ports/streaming-provider.port";

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
 * The one exception is `whipUrl` (Task 2): that shape — a `/whip/` nginx
 * prefix of its own, deliberately NOT nested under the HLS read prefix — WAS
 * proven against a running MediaMTX and a real publish before this adapter
 * was written. See `createSession`'s own docstring below.
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
    // Trailing slash stripped so concatenating "/u/<key>/index.m3u8"
    // below never produces a doubled "//" — the same rule
    // `resolveAppBaseUrl` (bootstrap.ts) applies to APP_BASE_URL.
    this.hlsBaseUrl = config.hlsBaseUrl.replace(/\/+$/, "");
    // Same rule, same reason, applied to the WHIP origin: concatenating
    // "/whip/u/<key>" below must never produce a doubled "//" from a
    // configured value that happens to carry a trailing slash.
    this.whipBaseUrl = config.whipBaseUrl.replace(/\/+$/, "");
  }

  /**
   * `whipUrl` is built as `<whipBaseUrl>/whip/u/<streamKey>` — NOT
   * symmetrical with the `<base>/u/<key>/...` shape `rtmpUrl` and
   * `hlsPlaybackPath` use, and the one asymmetry in this file.
   *
   * `/whip/` IS A SEPARATE nginx PREFIX, NOT NESTED UNDER THE READ PREFIX.
   * MediaMTX's own WHIP url shape is `/<namespace>/<streamKey>/whip`, which
   * sits literally under the `^~` prefix location the HLS read owns — and a
   * `^~` prefix location, once selected, makes nginx skip the regex phase
   * entirely, so a regex nested beneath it could never be reached. A prefix
   * that shares no leading characters with the read prefix sidesteps that
   * permanently, which is why the public WHIP path starts `/whip/` and the
   * namespace segment follows it rather than leading.
   *
   * WHY THE EXTRA `u/` SEGMENT, HISTORICALLY (Phase 7, Task 4): the community
   * world's WHIP url was the bare `<base>/whip/<key>`, deployed and proven
   * against a real MediaMTX and a real browser publish, and Phase 7 was
   * forbidden from changing it by a byte — so the user world took the extra
   * segment instead of the community world losing its bare one. Phase 8
   * deleted the community world, and this shape STAYS: it is what
   * `infra/nginx/live-hls.conf.template`'s `^~ /whip/u/` location serves and
   * what is deployed today. Shortening it would be a coordinated
   * config-and-code change with nothing to gain, not a cleanup.
   *
   * The session sub-resource MediaMTX hands back after the initial POST
   * (`<whipUrl>/<sessionId>`) is nginx's problem, not this adapter's — nginx
   * rewrites it correctly and nothing here needs to construct it.
   */
  createSession(input: {
    streamKey: string;
    namespace: StreamNamespace;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string } {
    // The MediaMTX path this session publishes to and is read from —
    // `u/<key>`, the one segment `parseStreamPath` recognises since
    // retire-telegram Task 6. Built from `input.namespace` rather than the
    // literal, because a hard-coded segment here is exactly the defect the
    // parameter exists to prevent (see `StreamNamespace`). RTMP and HLS both
    // carry this path verbatim; WHIP does not, for the reason above.
    const mtxPath = `${input.namespace}/${input.streamKey}`;
    return {
      rtmpUrl: `rtmp://${this.rtmpHost}:${RTMP_PORT}/${mtxPath}`,
      whipUrl: `${this.whipBaseUrl}/whip/${mtxPath}`,
      hlsPlaybackPath: `${this.hlsBaseUrl}/${mtxPath}/index.m3u8`,
    };
  }
}
