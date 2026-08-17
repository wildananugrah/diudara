/**
 * Password-reset tokens: minted once, sent over one channel, verified by
 * their hash — never their plaintext.
 *
 * Pure module: no imports from `application/` or `infrastructure/`, no
 * database, no clock — mirrors `domain/watch-token.ts` in that discipline,
 * though unlike that module this one is not itself signed. A reset token is
 * a bare random secret whose only proof of validity is "the database has a
 * row whose hash matches, unexpired and unused" — there is no payload to
 * verify offline, so there is nothing here for a `verify` function to do.
 */

import { randomBytes, createHash } from "node:crypto";

/**
 * 30 minutes. Short enough that a link sitting in an inbox or a WhatsApp
 * thread is not a long-lived credential; long enough that a member who has
 * to switch apps to read the message does not lose the race.
 */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * 32 random bytes, hex-encoded — 64 characters, 256 bits of entropy.
 *
 * NOT a uuid. A uuid's job is to identify a row cheaply and uniquely; it is
 * not drawn from a CSPRNG and several of its bits are fixed by the version,
 * so it is unsuitable as a bearer secret. `randomBytes` from `node:crypto`
 * is the CSPRNG this process already trusts `HonoJwtTokenIssuer` and
 * `watch-token.ts` to sit on top of.
 */
const TOKEN_BYTES = 32;

/**
 * Mints a fresh token and its sha256 hash together, so a caller can never
 * construct one without the other — `RequestPasswordReset` sends `token` and
 * stores only `tokenHash`, and there is no code path that reaches the
 * plaintext from the hash.
 */
export function mintResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  return { token, tokenHash: hashResetToken(token) };
}

/**
 * sha256 of `token`, hex-encoded. Deterministic — the same token always
 * hashes to the same value, which is what makes `findByHash` a lookup
 * rather than a scan-and-compare — and one-way: this module exposes no
 * inverse, and none exists.
 */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
