/**
 * MediaMTX stream paths.
 *
 * Every publish and every lifecycle hook carries the path verbatim as
 * `<namespace>/<key>` — confirmed against a real RTMP publish against this
 * deployment, which sent `{"path":"c/stage0testkey", ...}`, not taken from docs.
 *
 * The namespace exists so a stale or foreign path fails loudly instead of being
 * mistaken for one of ours: MediaMTX's hooks are configured under `all_others`,
 * so they fire for EVERY path anyone manages to publish to, not just DIUDARA's.
 */

/** `c` for community — a live session belongs to a community, not to an event. */
export const STREAM_NAMESPACE = "c";

/** Stream keys we mint. Anything outside this shape is not one of ours. */
const STREAM_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Returns the stream key from a MediaMTX path, or null when the path is not in
 * our namespace or the key is not a shape we could have issued.
 */
export function parseStreamPath(path: string | null | undefined): string | null {
  const raw = path?.trim();
  if (!raw) return null;

  const segments = raw.split("/");
  // Exactly two segments: "c/<key>". A deeper path is not ours, and MediaMTX
  // appends nothing of its own here.
  if (segments.length !== 2) return null;
  if (segments[0] !== STREAM_NAMESPACE) return null;

  const key = segments[1]!;
  return STREAM_KEY.test(key) ? key : null;
}

/** The path a creator publishes to, given their key. */
export const streamPathFor = (streamKey: string): string => `${STREAM_NAMESPACE}/${streamKey}`;

/**
 * Mints a stream key. 16 random bytes as base64url — 22 characters, ~128 bits.
 *
 * Length is a security property, not a style choice: :1935 is open to the
 * internet (that is how a creator's OBS reaches it) and is actively scanned, so
 * the key is the ENTIRE credential protecting a community's broadcast path.
 * The seeded `bimbel-sbmptn-live` was derivable from the public community slug.
 */
export function newStreamKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

/**
 * A publish credential. Same entropy as a stream key, different job: the key is
 * a PUBLIC path segment (it appears in every viewer's HLS url), this is the
 * secret that says a publisher may broadcast there.
 */
export const newPublishSecret = newStreamKey;

/**
 * Where the browser fetches HLS from. The prefix is proxied to MediaMTX's
 * loopback-only :8888 — by `deploy/nginx/diudara2.mhamzah.id` in production and
 * by `frontend/vite.config.ts` in dev. Change it in one place and BOTH must
 * follow, or playback 404s against the SPA's catch-all route.
 */
export const HLS_PATH_PREFIX = "/hls";

export const hlsPlaybackPath = (streamKey: string, watchToken: string): string =>
  `${HLS_PATH_PREFIX}/${streamPathFor(streamKey)}/index.m3u8?token=${encodeURIComponent(watchToken)}`;
