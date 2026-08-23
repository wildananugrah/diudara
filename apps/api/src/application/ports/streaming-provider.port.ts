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
   * `namespace` (Phase 7, Task 4) is REQUIRED, with no default, and that is
   * the whole point of it: a caller must SAY which world its stream belongs
   * to. Before this parameter existed both adapters hard-coded `live/` — the
   * community segment — so `StartUserStream`, the user world's own use case,
   * handed a creator `rtmp://host:1935/live/<key>`, which `parseStreamPath`
   * then read back as a community path and looked up in a table it had
   * nothing to do with. A default would have let exactly that mistake compile
   * again. `StreamNamespace` has one member today (below); the parameter
   * stays required anyway, because it is the requirement — not the number of
   * members — that closed that defect.
   */
  createSession(input: {
    streamKey: string;
    namespace: StreamNamespace;
  }): { rtmpUrl: string; whipUrl: string; hlsPlaybackPath: string };
}

/**
 * The top-level path segment a stream is published and read under, and the
 * ONE thing that tells apart the worlds this codebase can construct a stream
 * for. Since retire-telegram Task 7 there is exactly one.
 *
 * `u` names a person's own `user_stream` (design spec §6). `StartUserStream`
 * is the sole `createSession` call site in `src/`, and it passes `"u"`.
 *
 * `live` NAMED THE COMMUNITY `event` WORLD, AND IT IS GONE. Task 6 removed the
 * AUTHORISATION side (`parseStreamPath`'s `NAMESPACES` map holds `u` alone,
 * and `AuthoriseStream` refuses everything else); Task 7 removed the
 * CONSTRUCTION side — this union, `whipSuffix`'s two-branch asymmetry in
 * `mediamtx.adapter.ts`, and the adapter tests that pinned the community
 * shapes. Between those two tasks the two sides did not match: a caller could
 * still ASK an adapter for `rtmp://host:1935/live/<key>` and nothing would
 * ever authorise a publish to it — fail-closed, but at runtime rather than at
 * compile time. A one-member union is what makes it a compile error instead.
 *
 * A ONE-MEMBER UNION IS STILL A UNION, DELIBERATELY. It could be dropped and
 * `u/` hard-coded back into both adapters, which is exactly the shape Phase 7
 * had to undo: with the segment hard-coded, `StartUserStream` handed a creator
 * a `live/<key>` URL that `parseStreamPath` then read back as the wrong world
 * entirely. The parameter is what forces a caller to SAY which world its
 * stream belongs to, and adding a second namespace later means adding one
 * member here and one entry to `NAMESPACES` — not re-deriving the parameter.
 *
 * The construction and authorisation sides are deliberately declared
 * separately rather than derived from one another: the map's job is to REFUSE
 * a segment it does not know, which means it must own its own key set, and
 * importing a use-case's constant into a port would invert this codebase's
 * dependency direction for the sake of five characters. The cost of that
 * choice is that they must be kept in step BY HAND.
 */
export type StreamNamespace = "u";

/**
 * A fresh, unguessable stream key: 32 hex characters from 16 CSPRNG bytes
 * (128 bits of entropy) — `openssl rand`-grade, per the design spec (§4),
 * and enough that guessing one is not a viable attack even though MediaMTX's
 * RTMP port is public (§6).
 *
 * Lives here rather than on the port interface or either adapter, because it
 * is PROVIDER-NEUTRAL: `MediaMtxAdapter.createSession` and
 * `FakeStreamingAdapter.createSession` both take a key rather than minting
 * their own, so `StartUserStream` — the one caller left, after
 * retire-telegram deleted the community `ScheduleLiveSession` that was the
 * other — calls this exactly once, persists the result as
 * `user_stream.stream_key`, and hands the SAME key to whichever adapter
 * bootstrap() wired. A real provider call has no opinion on how the key was
 * generated, and neither should this port.
 */
export function newStreamKey(): string {
  return randomBytes(16).toString("hex");
}
