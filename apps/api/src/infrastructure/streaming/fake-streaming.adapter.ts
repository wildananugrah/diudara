import type { StreamingProviderPort } from "../../application/ports/streaming-provider.port";

/**
 * In-memory `StreamingProviderPort` for tests, and for `development`/`test`
 * boxes with no MediaMTX configured — selected by `selectStreamingProvider`
 * (bootstrap.ts) under the SAME `RELAXED_NODE_ENVS` allowlist
 * `FakeAiAdapter` is, and for the same reason: nothing is on the line if
 * streaming is not really wired up locally, so a developer working on
 * `ScheduleLiveSession` (Task 3) or the creator's streaming UI (Task 7) gets
 * URLs to look at without running MediaMTX at all.
 *
 * Like `MediaMtxAdapter`, `createSession` is pure URL construction and
 * cannot fail — the "fake-mediamtx.local" host is a placeholder, never a
 * real DNS name.
 *
 * Records every call so a test can assert what a use-case asked for without
 * inspecting the URLs' shape.
 *
 * FIX (final whole-branch review, minor): `hlsPlaybackPath` used to carry an
 * extra `/hls` segment (`https://fake-mediamtx.local/hls/live/<key>/...`)
 * that `MediaMtxAdapter` never produces — that adapter builds
 * `${hlsBaseUrl}/live/<key>/index.m3u8` with NOTHING inserted between the
 * configured base and `live/`; a `/hls` prefix only ever appeared in that
 * adapter's own tests because the EXAMPLE `hlsBaseUrl` they configured
 * happened to end in `/hls`, not because the adapter added it. Removed here
 * so the fake matches the real adapter's actual construction rule, not an
 * accidental shape nothing in `infra/nginx/live-hls.conf.template`'s
 * `/live/...` location would ever match.
 *
 * `whipUrl` (Task 2) is held to the SAME rule: `MediaMtxAdapter` builds it as
 * `${whipBaseUrl}/whip/<key>` — a separate nginx prefix, not nested under
 * `/live/` — so this fake matches that exactly rather than inventing its own
 * shape. A fake that drifts from its real counterpart is how integration
 * bugs hide.
 */
export class FakeStreamingAdapter implements StreamingProviderPort {
  readonly sessions: { streamKey: string }[] = [];

  createSession(input: {
    streamKey: string;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string } {
    this.sessions.push({ streamKey: input.streamKey });
    return {
      rtmpUrl: `rtmp://fake-mediamtx.local:1935/live/${input.streamKey}`,
      whipUrl: `https://fake-mediamtx.local/whip/${input.streamKey}`,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${input.streamKey}/index.m3u8`,
    };
  }
}
