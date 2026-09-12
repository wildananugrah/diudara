import { createHash } from "node:crypto";

/**
 * A public stream's HLS reads carry no watch token at all — see
 * `authorise-stream.ts`'s own docstring, "a public row needs no token". So a
 * public read's only per-viewer signal is its forwarded IP and User-Agent,
 * hashed rather than stored raw: `stream_viewer_heartbeat.identity` holds
 * whichever of this or a token's `viewerId` a read used, and neither should
 * be recoverable from the other.
 *
 * Domain-prefixed the same way `user-watch-token.ts`'s `DOMAIN` constant is,
 * so this hash can never collide with a token's `viewerId` even by
 * coincidence — the two identity kinds stay visibly distinct if ever
 * inspected in `stream_viewer_heartbeat` directly.
 *
 * APPROXIMATE, not exact, and that is accepted rather than fought: two
 * people behind the same NAT sharing a browser version collapse into one,
 * and a phone put down and picked up under a new IP counts twice. The
 * product category this feeds (a live viewer count) has never promised
 * exact numbers even where an exact signal exists.
 */
export function anonymousViewerIdentity(ip: string, userAgent: string): string {
  return createHash("sha256").update(`diudara.anon-viewer.v1:${ip}:${userAgent}`).digest("hex");
}
