import type { LiveRepository } from "../domain/ports.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import {
  hlsPlaybackPath, newPublishSecret, newStreamKey, parseStreamPath, streamPathFor, STREAM_NAMESPACE,
} from "../domain/streamPath.ts";
import type { AccessPolicy } from "./AccessPolicy.ts";

/**
 * What MediaMTX POSTs to `/webhooks/mediamtx/auth`, captured from real publishes
 * and reads against this deployment:
 *   {user, password, token, ip, action, path, protocol, id, query, userAgent}
 * `user`/`password` come from the RTMP url's query (`?user=…&pass=…`), `query`
 * is the raw query string of an HLS request. The rest is unused here.
 */
export type StreamAuthRequest = {
  action?: string | null;
  path?: string | null;
  query?: string | null;
  user?: string | null;
  password?: string | null;
};

export type StreamAuthDecision =
  | { allow: true; action: "publish"; streamKey: string; communityId: string }
  | { allow: true; action: "read"; streamKey: string; communityId: string; userId: string }
  | {
      allow: false;
      action: string;
      reason:
        | "unsupported_action" | "unknown_path" | "unknown_stream_key"
        | "bad_publish_secret"
        | "missing_watch_token" | "unknown_watch_token" | "expired_watch_token";
    };

/** An hour: long enough for a session, short enough that a leaked url goes stale. */
const WATCH_TOKEN_TTL_SECONDS = 3600;

/** The RTMP username is cosmetic — MediaMTX requires one; the password is the credential. */
const PUBLISH_USER = "diudara";

/**
 * Scope note (SPEC.md §6.1): this serves live SESSION state and live CHAT.
 * It does not implement a multi-party video call. MediaMTX is a broadcast relay,
 * not an SFU, so the participant tiles LiveRoomPage draws cannot be backed by it;
 * one broadcaster plus HLS viewers is what the infrastructure actually supports.
 */
export class LiveService {
  /**
   * `rtmpBaseUrl` is where a creator's OBS dials in — `rtmp://<host>:1935`. It is
   * injected rather than read from env here so the application layer keeps no
   * knowledge of deployment; container.ts is the only place that names it.
   */
  constructor(
    private readonly live: LiveRepository,
    private readonly access: AccessPolicy,
    private readonly rtmpBaseUrl: string,
  ) {}

  async forCommunity(communityId: string, userId: string | null) {
    await this.access.requireMember(communityId, userId);
    const session = await this.live.findActiveForCommunity(communityId);
    return session ?? { id: null, status: "idle" as const, title: null, viewerCount: 0, startedAt: null };
  }

  private async sessionForMember(sessionId: string, userId: string | null) {
    const chat = await this.live.listChat(sessionId);
    return chat;
  }

  async chat(communityId: string, userId: string | null) {
    await this.access.requireMember(communityId, userId);
    const session = await this.live.findActiveForCommunity(communityId);
    if (!session) return [];
    return this.sessionForMember(session.id, userId);
  }

  async postChat(communityId: string, userId: string, body: string) {
    await this.access.requireMember(communityId, userId);
    if (!body?.trim()) throw new ValidationError("Pesan tidak boleh kosong");
    const session = await this.live.findActiveForCommunity(communityId);
    if (!session) throw new NotFoundError("Sesi live");
    return this.live.postChat({ sessionId: session.id, userId, body: body.trim() });
  }

  /**
   * MediaMTX's runOnOnline/runOnOffline hooks, which is how a session learns it
   * is actually broadcasting. Nothing else in the system can tell: the creator
   * pointing OBS at the server is the only signal a stream started.
   *
   * Deliberately NOT a session factory. A stream key exists only because we
   * issued one, so an unknown key means a stale publish, not a new session —
   * inventing a row here would let anyone who guesses a path create sessions.
   */
  async handleLifecycle(hook: string, streamPath: string) {
    const streamKey = parseStreamPath(streamPath);
    // Wrong namespace is a CONFIGURATION error (the hooks fire for `all_others`,
    // so a stale path reaches us). Loud, so it cannot look like a healthy stream.
    if (!streamKey) throw new NotFoundError(`Stream path tidak dikenali: ${streamPath}`);

    if (hook !== "online" && hook !== "offline") {
      throw new ValidationError(`Hook tidak dikenali: ${hook}`);
    }

    const matched = hook === "online"
      ? await this.live.startByStreamKey(streamKey)
      : await this.live.endByStreamKey(streamKey);

    // 200 even when nothing matched: a key with no session is not a config
    // error, and a non-2xx would have MediaMTX retrying a hook that can never
    // succeed. The flag makes the no-op visible rather than silent.
    return { ok: true, hook, matched };
  }

  /**
   * MediaMTX's authHTTPAddress check, asked once per publish and once per read,
   * BEFORE a single frame is accepted. Any 2xx allows and anything else denies,
   * so this is the whole access control on a port the internet can dial.
   *
   * Until now it rubber-stamped: it checked the shared secret and ignored the
   * body, which meant anyone who reached :1935 could publish to any path —
   * including over a community that was mid-broadcast.
   *
   * Order matters. The action is checked first and the path second, so a foreign
   * or malformed path is refused without ever reaching the database; an unknown
   * key is a scan, and scans should cost us nothing.
   *
   * A key authorises regardless of session status. `ended` is not a revocation —
   * OBS drops and reconnects, and the offline hook has already flipped the row by
   * the time it does. Rotation is what revokes a key (Stage 3).
   */
  async authorise(request: StreamAuthRequest): Promise<StreamAuthDecision> {
    const action = request.action ?? "";
    // `publish` and `read` are the only actions this deployment serves;
    // api/metrics/pprof are excluded from HTTP auth in mediamtx.yml AND disabled,
    // so one arriving here means the config changed and should not be honoured.
    if (action !== "publish" && action !== "read") {
      return { allow: false, action, reason: "unsupported_action" };
    }

    const streamKey = parseStreamPath(request.path);
    if (!streamKey) return { allow: false, action, reason: "unknown_path" };

    const session = await this.live.findByStreamKey(streamKey);
    if (!session) return { allow: false, action, reason: "unknown_stream_key" };

    if (action === "publish") {
      // The KEY is public — Stage 4 put it in every viewer's HLS url, where any
      // member can read it out of devtools. The SECRET is what says "you may
      // broadcast here". A room without one cannot be broadcast to at all;
      // absent must never mean "anything matches".
      const presented = request.password ?? "";
      if (!session.publishSecret || presented !== session.publishSecret) {
        return { allow: false, action, reason: "bad_publish_secret" };
      }
      return { allow: true, action, streamKey, communityId: session.communityId };
    }

    // A read. MediaMTX authorises the HLS SESSION, not each request: it asks us
    // once, then carries its own `hlsSession` cookie — confirmed by replaying a
    // real playback. So this runs once per viewer, and a token that expires
    // mid-session keeps that session alive until the player stops.
    const token = new URLSearchParams(request.query ?? "").get("token");
    if (!token) return { allow: false, action, reason: "missing_watch_token" };

    const watch = await this.live.findWatchToken(token);
    // Key mismatch is deliberately the same answer as "no such token": a token
    // for another community's room is not a hint worth confirming. (Rotation is
    // handled separately — rotateStreamKey deletes the room's tokens outright.)
    if (!watch || watch.streamKey !== streamKey) {
      return { allow: false, action, reason: "unknown_watch_token" };
    }
    if (watch.expiresAt.getTime() <= Date.now()) {
      return { allow: false, action, reason: "expired_watch_token" };
    }

    return { allow: true, action, streamKey, communityId: session.communityId, userId: watch.userId };
  }

  /**
   * The ingest credentials an admin pastes into OBS.
   *
   * Provisioning is lazy — a community has no session row until someone asks for
   * its key — and it happens ONCE. Minting on every read would silently break the
   * OBS profile the creator configured five minutes earlier, which fails at the
   * worst possible moment: live, on air, with an audience waiting.
   */
  async streamCredentials(communityId: string, userId: string | null) {
    await this.access.requireAdmin(communityId, userId);
    return this.credentials(await this.room(communityId));
  }

  /**
   * Mints a new key, which is the ONLY way to revoke the old one: MediaMTX asks
   * for authorisation at connect and never again, so a publisher already on air
   * keeps streaming until it disconnects. What rotation guarantees is that the
   * old key cannot connect AGAIN.
   *
   * Rotating a `live` session therefore also ends it: the broadcast in flight is
   * still under the OLD path, so its `offline` hook would arrive carrying a key
   * this row no longer has, match nothing, and leave the room stuck `live`
   * forever — a lie the UI would repeat to every member.
   */
  async rotateStreamKey(communityId: string, userId: string | null) {
    await this.access.requireAdmin(communityId, userId);
    const room = await this.room(communityId);
    const streamKey = newStreamKey();
    const publishSecret = newPublishSecret();
    await this.live.rotateStreamKey(room.id, streamKey, publishSecret);

    // Rotation is revocation, and that has to include viewers. A watch token
    // resolves through the SESSION row, so without this an outstanding token
    // simply follows the room onto its new key and keeps working.
    await this.live.deleteWatchTokensForSession(room.id);

    const endedActiveSession = room.status === "live";
    if (endedActiveSession) await this.live.endByStreamKey(streamKey);

    return {
      ...this.credentials({
        ...room, streamKey, publishSecret, status: endedActiveSession ? "ended" : room.status,
      }),
      endedActiveSession,
    };
  }

  /**
   * The community's live room, provisioned on first ask — and healed on later
   * ones: a room created before publish secrets existed gets one here rather
   * than showing its owner a panel they cannot broadcast with.
   */
  private async room(communityId: string) {
    const existing = await this.live.findLatestForCommunity(communityId);
    if (!existing) {
      return this.live.createForCommunity({
        communityId, streamKey: newStreamKey(), publishSecret: newPublishSecret(),
      });
    }
    if (existing.publishSecret) return existing;

    const publishSecret = newPublishSecret();
    // Same key, new secret: the key is already in OBS profiles and viewer urls.
    await this.live.rotateStreamKey(existing.id, existing.streamKey, publishSecret);
    return { ...existing, publishSecret };
  }

  private credentials(session: { id: string; streamKey: string; status: string; publishSecret: string | null }) {
    // OBS pastes Server + "/" + Stream Key together, so the credential rides in
    // the Stream Key field as an RTMP query — verified against a real publish,
    // which arrived as {"user":"diudara","password":"…","query":"user=…&pass=…"}.
    const obsStreamKey = `${session.streamKey}?user=${PUBLISH_USER}&pass=${session.publishSecret ?? ""}`;
    return {
      sessionId: session.id,
      streamKey: session.streamKey,
      publishSecret: session.publishSecret,
      obsStreamKey,
      // Split the way OBS's own fields are: the RTMP app in "Server", the key in
      // "Stream Key". Pasting the whole ingest URL into "Server" is the classic
      // way to get a 1935 connection that authenticates against path `c` alone.
      serverUrl: `${this.rtmpBaseUrl}/${STREAM_NAMESPACE}`,
      ingestUrl: `${this.rtmpBaseUrl}/${streamPathFor(session.streamKey)}?user=${PUBLISH_USER}&pass=${session.publishSecret ?? ""}`,
      status: session.status,
    };
  }

  /**
   * "I am still watching." The player calls this while it plays, and the count
   * the room reports is simply how many distinct members said so recently
   * (VIEWER_PRESENCE_WINDOW_SECONDS).
   *
   * Requires a live session rather than tolerating its absence: presence that can
   * outlive the broadcast is the same fiction as the stored counter it replaces.
   */
  async heartbeat(communityId: string, userId: string) {
    await this.access.requireMember(communityId, userId);
    const session = await this.live.findActiveForCommunity(communityId);
    if (!session) throw new NotFoundError("Sesi live");
    await this.live.touchViewer(session.id, userId);
    return { ok: true as const };
  }

  /**
   * A member's permission to watch, as a row — the previous implementation
   * returned a random UUID it never stored, so `/auth` had nothing to check it
   * against and every read was effectively public.
   *
   * The token travels in the playback url's query, which is where MediaMTX hands
   * it back to us, and which it copies onto the child playlists and segments it
   * rewrites. Expired rows are pruned here so the table stays the size of the
   * audience rather than the history.
   */
  async watchToken(communityId: string, userId: string) {
    await this.access.requireMember(communityId, userId);
    const session = await this.live.findActiveForCommunity(communityId);
    if (!session) throw new NotFoundError("Sesi live");

    await this.live.deleteExpiredWatchTokens(new Date());

    const token = newStreamKey();
    const expiresAt = new Date(Date.now() + WATCH_TOKEN_TTL_SECONDS * 1000);
    await this.live.createWatchToken({ token, sessionId: session.id, userId, expiresAt });

    return {
      sessionId: session.id,
      token,
      expiresInSeconds: WATCH_TOKEN_TTL_SECONDS,
      playbackUrl: hlsPlaybackPath(session.streamKey, token),
    };
  }
}
