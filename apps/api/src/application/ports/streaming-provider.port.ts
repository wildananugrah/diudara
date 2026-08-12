import { randomBytes } from "node:crypto";

/**
 * Boundary to the live-streaming ingest/playback provider — MediaMTX in this
 * codebase (`MediaMtxAdapter`), with `FakeStreamingAdapter` standing in for
 * tests and for `development`/`test` boxes with no MediaMTX configured (see
 * `selectStreamingProvider` in bootstrap.ts).
 *
 * ONE method, and it makes no network call. MediaMTX's `authMethod: http`
 * (Task 4) accepts a publish to ANY path our own webhook authorises, so
 * nothing needs to be provisioned or registered at the provider before a
 * creator can go live — "creating a session" is minting a key
 * (`newStreamKey`, below) and building the URLs the creator's encoder (or,
 * as of Task 2, their browser) and the member's player need. See
 * `MediaMtxAdapter`'s docstring for the reasoning in full; it is worth
 * reading before assuming this port is unfinished because it has no HTTP
 * client.
 */
export interface StreamingProviderPort {
  /**
   * Pure URL construction from `streamKey` and whatever configuration the
   * concrete adapter was built with. Never throws, never awaits anything —
   * there is nothing here that can fail at the provider, because nothing
   * here talks to the provider.
   *
   * `whipUrl` (Task 2) is the creator's BROWSER publish target — WebRTC via
   * WHIP, an alternative to the `rtmpUrl` an encoder like OBS uses, ingesting
   * the SAME stream key into the SAME session. It carries the stream key
   * exactly as `rtmpUrl` does, so it is exactly as sensitive: owner-scoped at
   * every caller, never handed to a member.
   */
  createSession(input: {
    streamKey: string;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string };
}

/**
 * A fresh, unguessable stream key: 32 hex characters from 16 CSPRNG bytes
 * (128 bits of entropy) — `openssl rand`-grade, per the design spec (§4),
 * and enough that guessing one is not a viable attack even though MediaMTX's
 * RTMP port is public (§6).
 *
 * Lives here rather than on the port interface or either adapter, because it
 * is PROVIDER-NEUTRAL: `MediaMtxAdapter.createSession` and
 * `FakeStreamingAdapter.createSession` both take a key rather than minting
 * their own, so `ScheduleLiveSession` (Task 3) calls this exactly once,
 * persists the result as `event.stream_key`, and hands the SAME key to
 * whichever adapter bootstrap() wired. A real provider call has no opinion
 * on how the key was generated, and neither should this port.
 */
export function newStreamKey(): string {
  return randomBytes(16).toString("hex");
}
