import type { UserStreamRow } from "../ports/user-stream-repository.port";
import { VIEWER_HEARTBEAT_WINDOW_MS } from "../../domain/viewer-heartbeat-window";

export { VIEWER_HEARTBEAT_WINDOW_MS };

/**
 * THE ONE definition of what a live stream looks like on the wire — the
 * `toStreamView` `UserStreamRepositoryPort`'s own docstring anticipated ("the
 * wire shape is decided in exactly one place ... not re-derived per route").
 * Phase 6 split `post-views.ts` out of `read-posts.ts` for the same reason and
 * asserted the result key-for-key in three places; this file is that decision
 * applied to `user_stream`, where the stakes are higher: `UserStreamRow`
 * carries `streamKey`, and a stream key is a PUBLISH SECRET. One field
 * spread by accident and every reader of `GET /streams` can broadcast as
 * that creator.
 *
 * So the projection is CLOSED and built field by field below. Never
 * `{ ...row }`, never a helper that copies unknown keys, and never a bare
 * `select()` upstream (see `userStreamColumns` in
 * `drizzle-user-stream.repository.ts`, which enforces the same rule one layer
 * down).
 */
export interface StreamView {
  id: string;
  title: string;
  /** `public` | `members` — widened here for the same reason `PostView` widens a post's. */
  visibility: string;
  owner: { handle: string; displayName: string };
  /**
   * On EVERY row, not only gated ones — the same rule and the same reasoning
   * as `PostView.membersOnly`: the owner and a paying member are exactly the
   * two people who see no lock, and a conditional key would leave the client
   * unable to tell "not gated" from "gated, and you are in".
   */
  locked: boolean;
  /**
   * ABSENT — not `null`, ABSENT — for a viewer who is locked out. The design
   * spec's §5.1 rule for media, applied to video: the projection must never
   * send a playback path to somebody who may not watch. `PostView.media`
   * makes the same promise with `[]`; here the key itself goes, because a
   * `null` playback path and an absent one are indistinguishable to a player
   * and only one of them is provable with `Object.keys`.
   *
   * Present on every UNLOCKED row, unconditionally — the path is derived from
   * the stream's own id and needs no configuration to build (see
   * `userStreamPlaybackPath`), so `locked` is the ONLY thing that decides
   * whether this key exists. That is what lets `GET /streams` keep working
   * unchanged on a box with no streaming provider configured at all.
   */
  hlsPlaybackPath?: string;
  /**
   * On EVERY row, locked or not — a discovery signal, not something worth
   * hiding on a gated stream a visitor cannot yet watch. Distinct identities
   * with a heartbeat in the last `VIEWER_HEARTBEAT_WINDOW_MS`; `0` for a
   * stream nothing has recorded one for yet.
   */
  viewerCount: number;
}

/**
 * The PUBLIC playback path for a user stream, built from the stream's `id`
 * and NEVER from its `stream_key`.
 *
 * THIS IS THE OLD WORLD'S CRITICAL FIX, INHERITED RATHER THAN REDISCOVERED.
 * The community world's watch-link resolver (deleted by retire-telegram Task 3)
 * used to hand a member `event.hls_playback_path`, a URL built from the event's
 * stream key — the same string that authorises a PUBLISH. Every member's browser was
 * shown the creator's publish credential, in the network tab and in any
 * forwarded link. The fix was to build the member-facing URL from the row's
 * opaque `id` instead and let nginx rewrite it onto MediaMTX's internal,
 * key-bearing path after authorisation succeeds
 * (`infra/nginx/live-hls.conf.template`).
 *
 * `GET /streams` is that same hazard with a wider blast radius — the listing
 * is public — so it gets the same answer. A stream id is a row identifier; a
 * stream key is a credential.
 *
 * RELATIVE, not absolute, and deliberately: the deployed nginx serves the
 * SPA, the API and `/live/` from ONE public origin (see the template's own
 * "this is a fragment, meant to be pasted inside the real public HTTPS
 * server block" header), so a same-origin path needs no `MEDIAMTX_HLS_BASE_URL`
 * to build and is therefore identical on every box — a configured VPS, a
 * developer's `FakeStreamingAdapter` machine, and CI alike. The old world's
 * resolver built an ABSOLUTE URL from that env var only because its link also had
 * to survive being pasted into a WhatsApp message; nothing here leaves the browser
 * that asked.
 *
 * `u/` is Phase 7's namespace for a person's own stream (design spec §6,
 * `parseStreamPath`'s `NAMESPACES`) — never `live/`, which names the old
 * community world.
 */
export function userStreamPlaybackPath(streamId: string): string {
  return `/u/${streamId}/index.m3u8`;
}

/**
 * `locked` is REQUIRED, exactly as `toPostView`'s is, and for the worse of
 * the two reasons that function gives: a forgotten default here publishes a
 * playback path for a gated stream. It is the CALLER's answer — entitlement
 * needs a viewer id and a membership lookup, and both belong to the use case
 * that already has them (`ListLiveStreams`).
 */
export function toStreamView(row: UserStreamRow, locked: boolean, viewerCount: number): StreamView {
  const view: StreamView = {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    owner: { handle: row.ownerHandle, displayName: row.ownerDisplayName },
    locked,
    viewerCount,
  };
  if (!locked) {
    view.hlsPlaybackPath = userStreamPlaybackPath(row.id);
  }
  return view;
}
