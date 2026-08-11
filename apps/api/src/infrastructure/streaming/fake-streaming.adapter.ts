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
 */
export class FakeStreamingAdapter implements StreamingProviderPort {
  readonly sessions: { streamKey: string }[] = [];

  createSession(input: { streamKey: string }): { rtmpUrl: string; hlsPlaybackPath: string } {
    this.sessions.push({ streamKey: input.streamKey });
    return {
      rtmpUrl: `rtmp://fake-mediamtx.local:1935/live/${input.streamKey}`,
      hlsPlaybackPath: `https://fake-mediamtx.local/hls/live/${input.streamKey}/index.m3u8`,
    };
  }
}
