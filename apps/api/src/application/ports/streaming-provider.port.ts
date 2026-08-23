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
   *
   * `namespace` (Task 4) is REQUIRED, with no default, and that is the whole
   * point of it: a caller must SAY which world its stream belongs to. Before
   * this parameter existed both adapters hard-coded `live/`, so
   * `StartUserStream` — the new world's own use case — handed a creator
   * `rtmp://host:1935/live/<key>`, which `parseStreamPath` then read back as
   * `world: "community"` and looked up in the `event` table it has nothing to
   * do with. A default would have let exactly that mistake compile again.
   */
  createSession(input: {
    streamKey: string;
    namespace: StreamNamespace;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string };
}

/**
 * The top-level path segment a stream is published and read under, and the
 * ONE thing that tells the two worlds apart on the wire.
 *
 * These two literals are the SAME pair `parseStreamPath`'s `NAMESPACES` map
 * (authorise-stream.ts) recognises — `live` for the community `event` world,
 * `u` for a person's own `user_stream` (design spec §6). The two are
 * deliberately declared separately rather than derived from one another: the
 * map's job is to REFUSE a segment it does not know, which means it must own
 * its own key set, and importing a use-case's constant into a port would
 * invert this codebase's dependency direction for the sake of five
 * characters. They must be kept in step by hand, and adding a third
 * namespace means adding it in both places — see `NAMESPACES`' own docstring,
 * which says the same thing from the other side.
 */
export type StreamNamespace = "live" | "u";

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
