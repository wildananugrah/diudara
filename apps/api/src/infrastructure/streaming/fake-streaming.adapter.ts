import type {
  StreamingProviderPort,
  StreamNamespace,
} from "../../application/ports/streaming-provider.port";

/**
 * In-memory `StreamingProviderPort` for tests, and for `development`/`test`
 * boxes with no MediaMTX configured — selected by `selectStreamingProvider`
 * (bootstrap.ts) under the SAME `RELAXED_NODE_ENVS` allowlist
 * `FakeAiAdapter` is, and for the same reason: nothing is on the line if
 * streaming is not really wired up locally, so a developer working on
 * `StartUserStream` or the Siaran UI gets URLs to look at without running
 * MediaMTX at all.
 *
 * Like `MediaMtxAdapter`, `createSession` is pure URL construction and
 * cannot fail — the "fake-mediamtx.local" host is a placeholder, never a
 * real DNS name.
 *
 * Records every call so a test can assert what a use-case asked for without
 * inspecting the URLs' shape.
 *
 * EVERY SHAPE HERE MATCHES `MediaMtxAdapter`'s EXACTLY, and that is the whole
 * discipline of this file — a fake that drifts from its real counterpart is
 * how integration bugs hide. Two drifts have actually been caught:
 *
 *  - `hlsPlaybackPath` once carried an extra `/hls` segment that
 *    `MediaMtxAdapter` never produces. That adapter builds
 *    `${hlsBaseUrl}/<namespace>/<key>/index.m3u8` with NOTHING inserted
 *    between the configured base and the namespace; `/hls` only ever
 *    appeared in that adapter's own tests because the EXAMPLE `hlsBaseUrl`
 *    they configure happens to end in `/hls`.
 *  - `whipUrl` is `${whipBaseUrl}/whip/<namespace>/<key>` — a `/whip/` nginx
 *    prefix of its own, deliberately not nested under the HLS read prefix.
 *
 * `namespace` (Phase 7, Task 4) is held to the same rule. Since
 * retire-telegram Task 7 narrowed `StreamNamespace` to a single member there
 * is no second shape to get wrong: `MediaMtxAdapter`'s community-only
 * `whipSuffix` asymmetry — the bare `/whip/<key>` the deleted `live`
 * namespace kept — went with the namespace itself.
 */
export class FakeStreamingAdapter implements StreamingProviderPort {
  readonly sessions: { streamKey: string; namespace: StreamNamespace }[] = [];

  createSession(input: {
    streamKey: string;
    namespace: StreamNamespace;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string } {
    // Recorded WITH the namespace: "which world did the caller say this
    // stream belongs to" is exactly the question Phase 7's Task 4 exists
    // because nobody could previously ask it, and a test asserting on
    // `sessions` should be able to. It stays recorded with one namespace
    // left, because the recording is about what the CALLER said.
    this.sessions.push({ streamKey: input.streamKey, namespace: input.namespace });
    const mtxPath = `${input.namespace}/${input.streamKey}`;
    return {
      rtmpUrl: `rtmp://fake-mediamtx.local:1935/${mtxPath}`,
      whipUrl: `https://fake-mediamtx.local/whip/${mtxPath}`,
      hlsPlaybackPath: `https://fake-mediamtx.local/${mtxPath}/index.m3u8`,
    };
  }
}
