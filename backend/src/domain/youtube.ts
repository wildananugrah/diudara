/**
 * YouTube URL parsing.
 *
 * Creators paste whatever the share button gave them, which is at least five
 * different shapes plus timestamp/playlist query junk. Everything funnels
 * through here so validation and embedding can never disagree about what a
 * given link means.
 */

/** A video id is exactly 11 chars of the URL-safe base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com",
  "music.youtube.com", "youtu.be", "www.youtu.be",
]);

/** Path prefixes that carry the id as the next segment. */
const PATH_PREFIXES = ["embed", "shorts", "v", "live"];

/**
 * Returns the 11-character video id, or null if this is not a YouTube video URL.
 * A bare id is accepted too, so a creator who pasted just the id still works.
 */
export function parseYouTubeId(raw: string | null | undefined): string | null {
  const input = raw?.trim();
  if (!input) return null;
  if (VIDEO_ID.test(input)) return input;

  let url: URL;
  try {
    // Creators routinely omit the scheme; assume https rather than reject.
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }

  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  // youtu.be/<id> — the id is the whole path.
  if (url.hostname.toLowerCase().endsWith("youtu.be")) {
    return idOrNull(url.pathname.split("/").filter(Boolean)[0]);
  }

  // youtube.com/watch?v=<id>, including &list= and &t= which we ignore.
  const v = url.searchParams.get("v");
  if (v) return idOrNull(v);

  // youtube.com/embed/<id>, /shorts/<id>, /v/<id>, /live/<id>
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && PATH_PREFIXES.includes(segments[0]!.toLowerCase())) {
    return idOrNull(segments[1]);
  }

  return null;
}

const idOrNull = (candidate: string | undefined): string | null =>
  candidate && VIDEO_ID.test(candidate) ? candidate : null;

/** The privacy-preserving embed origin; `nocookie` avoids setting ad cookies on view. */
export const embedUrlFor = (videoId: string): string =>
  `https://www.youtube-nocookie.com/embed/${videoId}`;
