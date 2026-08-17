import { ApiError } from "../api";

/**
 * The personal-account session, plus every call to `/users/...`.
 *
 * THIS IS A SEPARATE SESSION FROM THE CREATOR DASHBOARD'S — see
 * `apps/web/src/dashboard/auth.ts` and `apiClient.ts`, which this file
 * mirrors deliberately rather than importing from. The codebase already has
 * two account systems (creator, personal user) with their own token types
 * (`UserTokenPayload` carries a different `typ` than the creator's — see
 * Task 2's `hono-jwt.user-token-issuer.ts`) and their own auth middleware
 * (`requireUserAuth` vs `requireAuth`), each rejecting the other's token. A
 * shared storage key or a shared listener set would let one session's
 * expiry silently affect the other's UI, so this stays a full parallel
 * implementation of the SAME DESIGN — localStorage, a Bearer header, and a
 * 401 clearing the token — not a new scheme.
 */

/** The ONE key the personal-account token lives under. Exported so tests assert on it rather than guess. */
export const USER_TOKEN_STORAGE_KEY = "diudara.user.token";

/** The signed-in user's own handle/name/email, cached so a page can greet them without an extra request. */
const USER_ACCOUNT_STORAGE_KEY = "diudara.user.account";

export interface SessionUser {
  id: string;
  handle: string;
  displayName: string;
  email: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  // A copy: a listener that unsubscribes itself while being notified would
  // otherwise mutate the set mid-iteration.
  for (const listener of [...listeners]) listener();
}

/** Subscribes to session changes. Returns the unsubscribe function, in the shape `useSyncExternalStore` expects. */
export function subscribeToUserAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUserToken(): string | null {
  // `localStorage` throws in a browser with storage disabled (Safari private
  // mode, historically). A page that cannot store a session should say "log
  // in" rather than throw during render.
  try {
    return localStorage.getItem(USER_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * **THE single answer to "is there a session?" — read from the TOKEN key and
 * from nothing else.**
 *
 * Final-review I2: that question used to be answered from two different
 * storage keys. `getProfileByHandle` asked `getUserToken()`
 * (`diudara.user.token`); `FollowRow` in `JelajahPage.tsx` asked
 * `getSessionUser() !== null` (`diudara.user.account`). Each was locally
 * defensible and together they were wrong, because nothing ever put the two
 * keys out of step in a test — every test either `localStorage.clear()`s or
 * goes through `setUserSession`, which writes both. In the divergent state the
 * review measured `"Masuk untuk mengikuti"` rendering on every row while a
 * perfectly valid token sat in storage.
 *
 * The token is the right key because it is the only one the SERVER can act on:
 * it is what `authorizedHeaders` attaches, and therefore what decides whether
 * the API sees a viewer at all. The account cache answers a DIFFERENT question
 * — "who am I?" — and `getSessionUser` stays the answer to that one. A missing
 * account cache is not a missing session; it is a session whose display name
 * and handle are unknown.
 *
 * Returns a boolean, not the token, so callers cannot accidentally start
 * treating the two questions as one again — and so `useSyncExternalStore`
 * compares a stable primitive.
 */
export function isUserSignedIn(): boolean {
  return getUserToken() !== null;
}

export function getSessionUser(): SessionUser | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(USER_ACCOUNT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, handle, displayName, email } = parsed as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      typeof handle !== "string" ||
      typeof displayName !== "string" ||
      typeof email !== "string"
    ) {
      return null;
    }
    return { id, handle, displayName, email };
  } catch {
    // Hand-edited in devtools, or written by an older build. Losing the
    // cached account is acceptable; crashing every page that reads it is not.
    return null;
  }
}

/** Bahasa Indonesia, because it is user-visible: `LoginPage` renders it. */
export const SESSION_NOT_STORED_MESSAGE =
  "Sesi tidak dapat disimpan di peramban ini. Coba lagi atau aktifkan penyimpanan situs.";

/**
 * Thrown by `setUserSession` when the account write fails AFTER the token
 * write succeeded. Its own class rather than a bare `Error` so `LoginPage` can
 * tell it from a network failure and show the right Bahasa sentence — a bare
 * `Error` lands in that page's "Tidak dapat menghubungi server" branch, which
 * would be a lie about what went wrong.
 */
export class SessionStorageError extends Error {
  constructor() {
    super(SESSION_NOT_STORED_MESSAGE);
    this.name = "SessionStorageError";
  }
}

/**
 * Stores the token and the account together, then notifies. **ALL OR NOTHING.**
 *
 * Final-review I2: these two `setItem` calls used to share one `try`, token
 * first. If the SECOND threw — quota, or Safari's storage behaviour, the same
 * class of failure `getUserToken`'s own try/catch two functions up already
 * anticipates — the token was already persisted, was never rolled back, and
 * `notify()` was skipped. The app then held a token with no account cache, and
 * the review measured the consequence: a live "Ikuti" button on your OWN
 * profile, collecting the 409 that three separate docstrings exist to prevent.
 *
 * So the second failure now UNDOES the first and throws. A caller that cannot
 * store a session must find out, rather than continuing with half of one.
 *
 * The FIRST write failing is different and still returns silently: nothing was
 * written, so there is no half state to clean up, and a browser with storage
 * disabled entirely should still be able to complete a login for the life of
 * the page rather than being refused outright. `notify()` is skipped either way
 * — announcing a session that `getUserToken()` cannot see would only make the
 * UI flicker.
 */
export function setUserSession(token: string, user: SessionUser): void {
  try {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, token);
  } catch {
    return;
  }

  try {
    localStorage.setItem(USER_ACCOUNT_STORAGE_KEY, JSON.stringify(user));
  } catch {
    try {
      localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
    } catch {
      // Storage that accepted a write and refuses a remove is beyond anything
      // this function can repair. Throwing below is still right: the caller
      // must not proceed as though the session were sound.
    }
    throw new SessionStorageError();
  }

  notify();
}

/**
 * Ends the session: both keys, then notify.
 *
 * Called on logout AND on any 401. Deliberately total — a token removed
 * while the cached account stayed would leave a page greeting somebody who
 * is no longer signed in.
 */
export function clearUserToken(): void {
  try {
    localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_ACCOUNT_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage never worked.
  }
  notify();
}

/**
 * An error from the personal-account API, with the 400's per-field messages
 * already split out — mirrors `DashboardApiError` exactly, including the
 * reasoning in `parseFieldErrors` below (copied rather than imported, for
 * the same "stay independent" reason the class docstring above gives).
 */
export class UserApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly fieldErrors: Readonly<Record<string, string>> = {}
  ) {
    super(message, status);
    this.name = "UserApiError";
  }
}

/**
 * Splits `validate()`'s "field: message; field2: message2" string into
 * `{ field: message }`. See `dashboard/apiClient.ts`'s own copy of this
 * function for the full reasoning — this is that same parser, verbatim.
 */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

export function parseFieldErrors(message: string): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const segment of message.split("; ")) {
    const separator = segment.indexOf(": ");
    if (separator <= 0) continue;
    const path = segment.slice(0, separator);
    const detail = segment.slice(separator + 2).trim();
    if (path === "body" || detail.length === 0 || !FIELD_PATH.test(path)) continue;
    const field = path.slice(path.lastIndexOf(".") + 1);
    if (!(field in fieldErrors)) fieldErrors[field] = detail;
  }
  return fieldErrors;
}

/** The error handler always responds `{ error: "..." }` — see apps/api/src/http/error-handler.ts. */
async function readError(res: Response, fallback: string): Promise<UserApiError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) message = body.error;
  } catch {
    // Not JSON (a proxy error page, an empty body) — keep the fallback.
  }
  return new UserApiError(message, res.status, res.status === 400 ? parseFieldErrors(message) : {});
}

/** Message shown when the session is gone. Never mentions the token itself. */
export const SESSION_EXPIRED_MESSAGE = "Sesi Anda sudah berakhir. Silakan masuk kembali.";

function authorizedHeaders(init: RequestInit | undefined, token: string | null): Headers {
  const headers = new Headers(init?.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

/**
 * One authenticated request, returning the raw `Response`.
 *
 * ON ANY 401 IT CLEARS THE TOKEN — see `dashboard/apiClient.ts`'s own
 * `apiRequest` docstring for the full reasoning, which applies unchanged
 * here: the token is valid for seven days, and clearing it on the first 401
 * is what lets a page's own session guard (see `SettingsPage.tsx`) notice
 * and redirect, instead of the screen sitting there erroring forever.
 */
export async function apiRequest(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { ...init, headers: authorizedHeaders(init, getUserToken()) });
  if (res.status === 401) {
    clearUserToken();
    throw new UserApiError(SESSION_EXPIRED_MESSAGE, 401);
  }
  return res;
}

/** One authenticated request whose JSON body is the result. Throws on any non-2xx. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiRequest(path, init);
  if (!res.ok) {
    throw await readError(res, `permintaan gagal (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * A public (unauthenticated) POST — signup, login, and both password-reset
 * endpoints are ALL public (see `routes/users.ts`'s own docstring: "signup
 * has no session yet, and login is how one is obtained"; password reset has
 * no session either, since the token in the link IS the credential). None
 * of them go through `apiRequest`: a stale token from a previous session
 * must not travel alongside credentials that might replace it.
 */
async function publicPost<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await readError(res, fallback);
  }
  return (await res.json()) as T;
}

/**
 * A **PUBLIC BUT NOT ANONYMOUS** GET whose JSON body is the result — the
 * `publicPost` above, but for `GET`. Backs Jelajah's three lists and a
 * profile's follower/following screens.
 *
 * **IT SENDS THE VIEWER'S TOKEN, and that is the whole point of this
 * function.** Its docstring used to justify sending nothing with "attaching a
 * stale Authorization header to a request nothing checks is pointless" — true
 * when written, and false from the moment the final review's item 1 put
 * `resolveViewerId` on all three of `/explore`, `/:handle/followers` and
 * `/:handle/following`. That viewer id is the ONLY input to the per-row
 * `viewerFollows`, so with no header every row of `/@you/mengikuti` comes back
 * `viewerFollows: null` and renders "Masuk untuk mengikuti" to somebody who is
 * signed in — the gate's Critical from `11b8848`, verbatim, one function over.
 * The review named this seam explicitly: "it becomes the gate's Critical again
 * the moment item 1 is done, and nothing guards it." Both directions are now
 * pinned in `apiClient.test.ts`.
 *
 * Deliberately NOT routed through `apiRequest`, for the same reason
 * `getProfileByHandle` is not: `apiRequest` clears the session and throws
 * `SESSION_EXPIRED_MESSAGE` on a 401, which is right for a route that REQUIRES
 * a session and wrong for one that merely NOTICES it. These three routes never
 * answer 401 at all — `resolveViewerId` degrades a bad token to anonymous — so
 * an expired token must show the anonymous view, never sign a visitor out
 * mid-browse. `authorizedHeaders` attaches the token when there is one and
 * nothing whatsoever when there is not, so the signed-out path is byte-identical
 * on the wire to sending no init at all.
 */
async function publicGet<T>(path: string, fallback: string): Promise<T> {
  const res = await fetch(path, { headers: authorizedHeaders(undefined, getUserToken()) });
  if (!res.ok) {
    throw await readError(res, fallback);
  }
  return (await res.json()) as T;
}

interface AuthSuccess {
  user: SessionUser;
  token: string;
}

/** `POST /users/login`. Stores the returned session on success. */
export async function login(input: { email: string; password: string }): Promise<AuthSuccess> {
  const result = await publicPost<AuthSuccess>("/users/login", input, "gagal masuk");
  setUserSession(result.token, result.user);
  return result;
}

/**
 * `POST /users/signup`. Returns `{ ok: true }` ONLY — no user, no token.
 *
 * DOES NOT LOG THE CALLER IN, and a duplicate email answers with this exact
 * same shape — see `RegisterUser`'s own docstring (Task 2/5) for why that
 * asymmetry (a duplicate HANDLE still 409s) is deliberate and must not be
 * "fixed". `SignupPage` sends every successful call here, indistinguishable
 * or not, to the login page with the same Indonesian notice.
 */
export function signup(input: {
  handle: string;
  email: string;
  password: string;
  displayName: string;
  whatsappNumber?: string;
}): Promise<{ ok: true }> {
  return publicPost("/users/signup", input, "pendaftaran gagal");
}

/**
 * `GET /users/by-handle/:handle`. **PUBLIC BUT NOT ANONYMOUS**, and the
 * distinction is the whole reason this function does not simply call
 * `publicGet`.
 *
 * `routes/users.ts` runs `resolveViewerId` on this route — never
 * `requireAuth`, so a missing, malformed or expired token resolves to `null`
 * (anonymous) instead of a 401, and a signed-out visitor can still read any
 * profile. But that viewer id is the ONLY input to
 * `PublicUserProfile.viewerFollows`, so the bearer header is what decides
 * whether the follow toggle exists at all: `FollowButton` renders a
 * `<Link to="/masuk">Masuk untuk mengikuti</Link>` for `null` and the real
 * button only for `true`/`false`.
 *
 * THIS USED TO SEND NO HEADER, and its docstring used to justify that with
 * "attaching a stale Authorization header to a request nothing checks would
 * be pointless". That was true when written (the accounts phase, before
 * following existed) and became false the moment Task 2 added
 * `resolveViewerId` to the route — so every signed-in visitor to `/@handle`
 * got `viewerFollows: null` and was told to sign in on a page they were
 * already signed in on. Found by Task 6's gate in a real browser, not by
 * any test: `ProfilePage`'s own tests mock this module, and this module's
 * tests asserted only the URL. Both directions are now pinned in
 * `apiClient.test.ts`.
 *
 * Still NOT routed through `apiRequest`, and that part of the original
 * reasoning stands: `apiRequest` clears the session and throws
 * `SESSION_EXPIRED_MESSAGE` on a 401, which is right for a route that
 * REQUIRES a session and wrong for one that merely notices it — an expired
 * token here must degrade to the anonymous view, not log the visitor out
 * mid-browse. `authorizedHeaders` (shared with `apiRequest`) attaches the
 * token when there is one and nothing at all when there is not.
 */
/**
 * Fields common to every profile shape `/users/...` returns, public or own —
 * mirrors the API's own `UserProfileCore`
 * (`apps/api/src/application/use-cases/get-user-profile.ts`) deliberately,
 * split out for the exact same reason that file's own docstring gives:
 * `OwnUserProfile` below must extend THIS, never `PublicUserProfile`.
 * `PublicUserProfile` widened by three fields (`followerCount`,
 * `followingCount`, `viewerFollows`) once following existed (Task 5); if
 * `OwnUserProfile` inherited from it instead of from this shared core, `GET
 * /users/me`'s type would falsely claim those three fields even though that
 * endpoint has never returned them — the exact structural mistake Task 2
 * avoided server-side, carried over here for the same reason.
 */
export interface UserProfileCore {
  handle: string;
  displayName: string;
  bio: string | null;
  /** ISO-8601, as it comes off the wire — never parsed to a `Date` here, since nothing on this page does arithmetic on it. */
  createdAt: string;
}

/**
 * `GET /users/by-handle/:handle`'s response shape. Task 5 widens this by
 * exactly three fields, mirroring the API's own `PublicUserProfile`
 * (see that interface's own docstring for the full reasoning):
 * `followerCount`, `followingCount`, and `viewerFollows`.
 *
 * `viewerFollows` is `null` for a signed-out visitor, `false` for a
 * signed-in visitor who does not follow this profile, `true` for one who
 * does. **It is `false`, not `null` or anything special, on YOUR OWN
 * profile** — the API deliberately emits no self-signal (see the API's own
 * docstring), so a follow button must decide "is this my own profile?" by
 * comparing handles, never by reading this field alone. See
 * `FollowButton.tsx`'s own docstring for where that comparison happens.
 */
export interface PublicUserProfile extends UserProfileCore {
  followerCount: number;
  followingCount: number;
  viewerFollows: boolean | null;
}

export async function getProfileByHandle(handle: string): Promise<PublicUserProfile> {
  const token = getUserToken();
  const res = await fetch(`/users/by-handle/${encodeURIComponent(handle)}`, {
    // Signed out this is an empty `Headers`, which is byte-identical on the
    // wire to sending no init at all — the signed-out path is unchanged.
    headers: authorizedHeaders(undefined, token),
  });
  if (!res.ok) {
    throw await readError(res, `gagal memuat profil (${res.status})`);
  }
  return (await res.json()) as PublicUserProfile;
}

/**
 * `GET /users/me`'s shape — the CORE fields plus the caller's own email and
 * WhatsApp number. Extends `UserProfileCore`, not `PublicUserProfile` — see
 * that interface's own docstring above for why.
 */
export interface OwnUserProfile extends UserProfileCore {
  email: string;
  whatsappNumber: string | null;
}

export function getOwnProfile(): Promise<OwnUserProfile> {
  return apiFetch<OwnUserProfile>("/users/me");
}

/**
 * `PATCH /users/me`. `handle` is deliberately not an accepted input here —
 * see `updateProfileSchema`'s own docstring for why a handle in the body
 * would be silently stripped rather than honoured, and never send one.
 *
 * `whatsappNumber` follows `updateProfileSchema`'s own `null`-clears/absent-
 * leaves-alone rule, same as `bio` — added by the whole-branch review (item
 * 1): before this, the number was writable only once, at signup, and
 * `SettingsPage` showed it read-only. See that page's own docstring for the
 * enumeration-safety consequence this closes.
 */
export function updateOwnProfile(
  patch: { displayName?: string; bio?: string | null; whatsappNumber?: string | null }
): Promise<OwnUserProfile> {
  return apiFetch<OwnUserProfile>("/users/me", { method: "PATCH", body: JSON.stringify(patch) });
}

/**
 * `POST /users/password-reset/request`. ALWAYS resolves `{ ok: true }` on a
 * 200 — the API answers identically whether or not the account exists (Task
 * 5), and this function must not do anything that could tell the two apart
 * either (no retry-on-one-case, no different timing deliberately introduced
 * here). `ResetRequestPage` renders the SAME Indonesian sentence for every
 * successful call.
 */
export function requestPasswordReset(email: string): Promise<{ ok: true }> {
  return publicPost("/users/password-reset/request", { email }, "permintaan gagal dikirim");
}

/**
 * `POST /users/password-reset/complete`. A missing, expired or already-used
 * token all answer with the SAME 401 — see `CompletePasswordReset`'s own
 * docstring — so `ResetCompletePage` shows one message for all three and
 * never tries to tell them apart from the error alone.
 */
export function completePasswordReset(token: string, newPassword: string): Promise<{ ok: true }> {
  return publicPost("/users/password-reset/complete", { token, newPassword }, "gagal mengganti sandi");
}

/**
 * A single row in a follower/following list or a Jelajah result — mirrors the
 * API's own `FollowListRowForViewer`
 * (`apps/api/src/application/use-cases/viewer-follow-state.ts`) exactly: the
 * same shape backs `GET /:handle/followers`, `/:handle/following` and
 * `/explore`'s three lists.
 *
 * Still narrower than `PublicUserProfile` — no counts — but it DOES carry
 * `viewerFollows` as of the final review's item 1, with the identical contract:
 * `null` when the request carried no usable viewer, `boolean` when it did, and
 * **`false` on your own row**, since the API emits no self-signal. Before this,
 * `FollowRow` guessed the value from whether a session existed, so every row of
 * `/@you/mengikuti` — the list of everyone you follow — read "Ikuti".
 */
export interface FollowListRow {
  handle: string;
  displayName: string;
  bio: string | null;
  viewerFollows: boolean | null;
}

/**
 * `POST /:handle/follow`. Idempotent and always resolves `{ following: true
 * }` — see `FollowUser`'s own docstring for why this is the RESULTING
 * state, not whether a row changed, and why that is exactly the shape
 * `FollowButton`'s optimistic update needs.
 */
export function followUser(handle: string): Promise<{ following: boolean }> {
  return apiFetch<{ following: boolean }>(`/users/${encodeURIComponent(handle)}/follow`, { method: "POST" });
}

/** `DELETE /:handle/follow` — the other half of `followUser` above, same idempotency guarantee. */
export function unfollowUser(handle: string): Promise<{ following: boolean }> {
  return apiFetch<{ following: boolean }>(`/users/${encodeURIComponent(handle)}/follow`, { method: "DELETE" });
}

/** `GET /:handle/followers` — public, reachable by tapping a profile's follower count. */
export function listFollowers(handle: string, limit?: number): Promise<FollowListRow[]> {
  const search = limit !== undefined ? `?limit=${limit}` : "";
  return publicGet<FollowListRow[]>(
    `/users/${encodeURIComponent(handle)}/followers${search}`,
    "gagal memuat daftar pengikut"
  );
}

/** `GET /:handle/following` — the other half of `listFollowers` above. */
export function listFollowing(handle: string, limit?: number): Promise<FollowListRow[]> {
  const search = limit !== undefined ? `?limit=${limit}` : "";
  return publicGet<FollowListRow[]>(
    `/users/${encodeURIComponent(handle)}/following${search}`,
    "gagal memuat daftar mengikuti"
  );
}

/**
 * `GET /explore`. `q` omitted or empty is Jelajah's DEFAULT state, not an
 * error — see `ExploreUsers`'s own docstring: `results` comes back `[]` and
 * `newest`/`mostFollowed` are still populated either way.
 */
export interface ExploreResult {
  results: FollowListRow[];
  newest: FollowListRow[];
  mostFollowed: FollowListRow[];
}

export function exploreUsers(input: { q?: string; limit?: number } = {}): Promise<ExploreResult> {
  const params = new URLSearchParams();
  if (input.q !== undefined && input.q.length > 0) params.set("q", input.q);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const query = params.toString();
  const search = query.length > 0 ? `?${query}` : "";
  return publicGet<ExploreResult>(`/users/explore${search}`, "gagal memuat Jelajah");
}
