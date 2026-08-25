import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { USER_TOKEN_TTL_SECONDS } from "../infrastructure/auth/hono-jwt.user-token-issuer";

/**
 * The one credential a browser will attach to an `<img>` by itself.
 *
 * `PostCard` renders `<img src="/users/media/:id/thumb">`. That request cannot
 * carry an `Authorization` header — there is no API for giving one to an image
 * — so before this existed every gated image reached the entitlement gate as an
 * anonymous caller and was refused. Members-only photos were invisible to the
 * author who posted them and to every member who had paid for them.
 *
 * DELIBERATELY NARROW. This is a media credential, not a second way to be
 * signed in:
 *
 *   - `Path=/users/media` — a browser never offers it to any other route, so it
 *     cannot be replayed against `/users/me`, `/users/posts`, or anything else.
 *   - The server refuses it elsewhere anyway. `Path` is a client-side courtesy;
 *     any client can send any cookie to any path. Only `resolveMediaViewerId`
 *     reads this cookie, and only the two media GET handlers call it.
 *   - `SameSite=Lax` with only safe, idempotent GETs behind it, so it adds no
 *     CSRF surface: there is no state-changing request it can authorise.
 *   - `HttpOnly`, so a script cannot read the token back out of it. The web app
 *     keeps its own copy in localStorage for `Authorization` headers; this one
 *     exists only for the requests that cannot use those.
 *
 * It carries the SAME JWT as the header path and is verified by the same
 * function, so `session_epoch` revocation applies to it too: a password reset
 * ends this session exactly as it ends the others.
 */
export const MEDIA_SESSION_COOKIE = "diudara_media_session";

/**
 * Scoped to the media routes and nothing above them. Changing this widens what
 * the browser will send the token to — it is the main thing keeping this from
 * becoming an ambient session cookie.
 */
export const MEDIA_SESSION_PATH = "/users/media";

/** Issued at login, alongside the token in the response body. */
export function setMediaSessionCookie(c: Context, token: string): void {
  setCookie(c, MEDIA_SESSION_COOKIE, token, {
    path: MEDIA_SESSION_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    // The token's own lifetime, imported rather than repeated: a cookie that
    // outlived its token would be a credential the server rejects and the
    // browser keeps re-sending on every image on every page.
    maxAge: USER_TOKEN_TTL_SECONDS,
  });
}

/**
 * Cleared on logout. MUST use the same path — a browser matches a deletion to
 * the cookie by name AND path, so clearing on `/` would leave this one in place
 * and still working.
 */
export function clearMediaSessionCookie(c: Context): void {
  deleteCookie(c, MEDIA_SESSION_COOKIE, { path: MEDIA_SESSION_PATH, secure: true, sameSite: "Lax" });
}
