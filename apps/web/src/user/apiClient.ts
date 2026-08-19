import { ApiError } from "../api";
import { MAX_UPLOAD_BYTES } from "@diudara/shared";

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
    // Extra keys (an `id` a pre-Task-7 build wrote) are ignored, not
    // rejected — see `repairSplitSession`'s docstring for why `id` was
    // dropped from `SessionUser` and why an already-stored blob containing
    // it must still parse.
    const { handle, displayName, email } = parsed as Record<string, unknown>;
    if (typeof handle !== "string" || typeof displayName !== "string" || typeof email !== "string") {
      return null;
    }
    return { handle, displayName, email };
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
    readonly fieldErrors: Readonly<Record<string, string>> = {},
    /**
     * **The API's own machine-readable label for this refusal, when it sent one
     * — the thing to BRANCH on.**
     *
     * `POST /users/media` sends it (`UPLOAD_ERROR_CODE` in `@diudara/shared`)
     * and `errorCopy.ts` is the only reader. Undefined everywhere else, and
     * undefined for anything that is not JSON from this API at all — an nginx
     * error page, a gateway timeout — which is exactly why a reader must treat
     * an absent code as "no information", never as a default reason.
     *
     * It is a protocol token and is NEVER shown to anybody; the sentence a
     * person reads is authored in `errorCopy.ts`, same as always.
     */
    readonly code?: string
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

/** The error handler always responds `{ error: "..." }`, and `{ error, code }` where the route has a machine-readable reason — see apps/api/src/http/error-handler.ts. */
async function readError(res: Response, fallback: string): Promise<UserApiError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    // Carried through UNINTERPRETED. This function's job is to move the wire's
    // fields onto the error; deciding what any of them mean is `errorCopy.ts`'s.
    if (typeof body.code === "string" && body.code.length > 0) code = body.code;
  } catch {
    // Not JSON (a proxy error page, an empty body) — keep the fallback, and
    // leave `code` undefined. nginx's own 413 page lands here.
  }
  return new UserApiError(
    message,
    res.status,
    res.status === 400 ? parseFieldErrors(message) : {},
    code
  );
}

/** Message shown when the session is gone. Never mentions the token itself. */
export const SESSION_EXPIRED_MESSAGE = "Sesi Anda sudah berakhir. Silakan masuk kembali.";

function authorizedHeaders(init: RequestInit | undefined, token: string | null): Headers {
  const headers = new Headers(init?.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  // `FormData` is the one body this must NOT label. Task 8's `uploadMedia`
  // sends multipart, and `fetch` generates the `boundary=...` parameter itself
  // — but only when it is the one setting `Content-Type`. Writing
  // `application/json` over it (which this did for ANY body before the media
  // upload existed) sends a body the API parses as an empty form and refuses
  // with "berkas foto wajib disertakan", for a request that carried the file.
  if (
    init?.body !== undefined &&
    init.body !== null &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
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

/**
 * `GET /users/by-handle/:handle` — **PUBLIC BUT NOT ANONYMOUS**, exactly like
 * the three list endpoints, so it goes through the exact same `publicGet`.
 *
 * IT USED TO BE A HAND-ROLLED COPY of `publicGet`: its own `fetch`, its own
 * `authorizedHeaders`, its own `readError`. Its docstring even opened by
 * claiming "the distinction is the whole reason this function does not simply
 * call `publicGet`" — which was never the real reason. The real reason was that
 * `publicGet` sent no token at the time, and the copy is what made it possible
 * to forget the viewer header in ONE of them without the other noticing. It was
 * then forgotten in each, separately: here until `11b8848` (the gate's
 * Critical), and in `publicGet` until `926bb10` (the same Critical, one function
 * over). Two places to forget it, forgotten twice. Now there is one place.
 *
 * See `publicGet` itself for the contract both callers share: the token is
 * attached when there is one and nothing at all when there is not, and this is
 * deliberately NOT routed through `apiRequest`, because `apiRequest` clears the
 * session and throws on a 401 — right for a route that REQUIRES a session,
 * wrong for one that merely NOTICES one. An expired token must degrade to the
 * anonymous view, never sign a visitor out mid-browse.
 */
export function getProfileByHandle(handle: string): Promise<PublicUserProfile> {
  return publicGet<PublicUserProfile>(
    `/users/by-handle/${encodeURIComponent(handle)}`,
    "gagal memuat profil"
  );
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
 * The token key and the account key can disagree — a corrupt or hand-edited
 * account blob leaves `isUserSignedIn()` true while `getSessionUser()` is null,
 * and in that state a live "Ikuti" renders on your own profile.
 *
 * Repaired AT THE CAUSE. Phase 2 shipped this residual and its review's condition
 * was that Phase 3 fix the cause rather than the three screens that render
 * wrongly because of it — the instance-versus-class distinction that cost this
 * project a whole extra round when two fixes each closed their own call site and
 * a guard test then found four more offenders.
 *
 * Swallows its own failure deliberately: this runs on every app start, and a
 * network blip must not stop the app rendering. A 401 inside `apiFetch` already
 * clears the dead token, which is the correct outcome.
 */
export async function repairSplitSession(): Promise<void> {
  if (getSessionUser() !== null) return;
  // No separate `isUserSignedIn()` check here on purpose (fix round 1's
  // ruling): that function IS `getUserToken() !== null`, and this line reads
  // the token directly one line later anyway — a second copy of the same
  // check was dead weight that also made a prescribed mutation test
  // unfalsifiable (see the Task 7 report's fix-round-1 section). This
  // `token === null` return is the one and only signed-in check, and it is
  // load-bearing: it is what lets `setUserSession` below take a `string`
  // rather than `string | null`.
  const token = getUserToken();
  if (token === null) return;
  try {
    const me = await getOwnProfile();
    setUserSession(token, { handle: me.handle, displayName: me.displayName, email: me.email });
  } catch {
    // Nothing to do: a 401 has already cleared the token, and any other failure
    // leaves the split state to be retried on the next start.
  }
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

/**
 * One image on a post, as the wire sees it — mirrors the API's own `MediaView`
 * (`apps/api/src/application/use-cases/post-views.ts`) exactly: three fields,
 * and **no URL**. The id is the only identifier that ever leaves the server, and
 * every path is derived from it on this side (see `mediaThumbUrl`), which is
 * what lets Phase 6 gate delivery in one place — a URL handed out today would
 * outlive any check added later (spec §5.1).
 *
 * `width` and `height` are what a card needs to reserve space, so a feed does
 * not reflow as images land.
 */
export interface MediaView {
  id: string;
  width: number;
  height: number;
}

/**
 * The thumbnail path for one media id — `GET /users/media/:id/thumb`, which
 * PROXIES the bytes rather than redirecting to the bucket (spec §5.1).
 *
 * Encoded even though the API only ever emits uuids: this value goes straight
 * into an `<img src>`, and an id carrying a `/` or a `?` would otherwise
 * address a different route entirely.
 */
export function mediaThumbUrl(id: string): string {
  return `/users/media/${encodeURIComponent(id)}/thumb`;
}

/**
 * `POST /users/media` (201) — one photo, as multipart, under the field name
 * the route reads (`form.get("file")` in `apps/api/src/routes/media.ts`;
 * anything else is a 400 in Bahasa).
 *
 * Goes through `apiFetch` like every other authenticated call, so a 401 clears
 * the session in the one place that does that. **It deliberately sets no
 * `Content-Type`** — see `authorizedHeaders` above for why writing one here
 * would send a request the API parses as an empty form.
 *
 * The upload is claimed by nothing until a post names its id: an id that is
 * never sent to `POST`/`PATCH /users/posts` stays unclaimed and is swept
 * (spec §8), which is exactly what makes "Batal" on the edit composer safe.
 */
export function uploadMedia(file: File): Promise<MediaView> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch<MediaView>("/users/media", { method: "POST", body: form });
}

/**
 * **The biggest photo the API will accept, re-exported here so a file that
 * cannot possibly succeed is refused before it is uploaded.**
 *
 * **ONE DEFINITION, in `@diudara/shared` — this used to be a second literal.**
 * The argument for copying it was that the two could only drift in a safe
 * direction, and the final whole-branch review overturned the reasoning without
 * touching the conclusion about drifting LOW: drifting HIGH is not safe. An
 * oversized file would then reach the API, come back a 400, and the upload copy
 * would have labelled it a format problem. `MAX_POST_BODY_LENGTH` was already
 * the precedent — read by the composer, the route schema and the use case
 * alike.
 *
 * **The server remains the authority.** `UploadMedia` checks the byte length
 * itself before sharp ever sees the bytes; this check only saves a person on a
 * phone connection from spending a 12 MB upload to be told no, which is why it
 * lives beside the picker and not anywhere a request could already be in
 * flight.
 */
export { MAX_UPLOAD_BYTES };

/** `GET /users/limits`'s response shape — one number today (spec §6). */
export interface PostLimits {
  maxPostImages: number;
}

/**
 * `GET /users/limits` — public and cheap. See `loadPostImageLimit` for the one
 * caller that matters and for what happens when this fails.
 */
export function getLimits(): Promise<PostLimits> {
  return publicGet<PostLimits>("/users/limits", "gagal memuat batas kiriman");
}

/**
 * **How many photos the composer offers when the server has not said
 * otherwise, and the answer to a `GET /users/limits` that never arrives.**
 *
 * Deliberately a SEPARATE number from the API's own `DEFAULT_MAX_POST_IMAGES`
 * (`apps/api/src/bootstrap.ts`) rather than a shared constant, and the two
 * being equal today is a coincidence this file must not depend on: the API
 * reads `MAX_POST_IMAGES` from its env at boot, so any deployment can move its
 * real cap without the web build changing at all. **The server is the
 * authority** — the route schema enforces the real number and answers a Bahasa
 * 400 — and this copy is ADVISORY, which is precisely what makes the failure
 * path below safe (spec §6).
 */
export const FALLBACK_MAX_POST_IMAGES = 5;

let maxPostImages: number = FALLBACK_MAX_POST_IMAGES;
const postImageLimitListeners = new Set<Listener>();

/** Subscribes to changes in the advisory limit, in the shape `useSyncExternalStore` expects. */
export function subscribeToPostImageLimit(listener: Listener): () => void {
  postImageLimitListeners.add(listener);
  return () => {
    postImageLimitListeners.delete(listener);
  };
}

/**
 * `useSyncExternalStore`'s snapshot: the limit as currently known. **Never
 * fetches** — it is read during render, and a render must not start a request.
 */
export function getMaxPostImages(): number {
  return maxPostImages;
}

/**
 * Learns the server's limit, ONCE, at app boot (`App.tsx`), and tells every
 * mounted composer.
 *
 * **It cannot fail.** A dead endpoint, a 500, an offline phone, a proxy error
 * page, an older server that does not know this route — every one of them
 * leaves `FALLBACK_MAX_POST_IMAGES` in place and resolves. Spec §6 states the
 * reason as a product decision rather than a defensive habit: "a composer that
 * refuses to open because a config endpoint is down would be a worse product
 * than one that occasionally offers a sixth photo and is told no." The cost of
 * being wrong here is bounded at exactly one Bahasa 400 from a route that was
 * always the authority.
 *
 * The shape is checked rather than trusted for the same reason: `{ maxPostImages:
 * "5" }` or a `0` from something upstream would otherwise become the composer's
 * cap and disable "Tambah foto" for ever — refusing to attach anything, which is
 * the failure this whole design exists to avoid.
 */
export async function loadPostImageLimit(): Promise<void> {
  let limits: PostLimits;
  try {
    limits = await getLimits();
  } catch {
    return;
  }
  const value = limits.maxPostImages as unknown;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return;
  if (value === maxPostImages) return;
  maxPostImages = value;
  // A copy: a listener that unsubscribes itself while being notified would
  // otherwise mutate the set mid-iteration — same rule as `notify()` above.
  for (const listener of [...postImageLimitListeners]) listener();
}

/**
 * TEST-ONLY. Puts the advisory limit back to the built-in default — this module
 * is a singleton for the life of the page (or of a test file), so without it a
 * test that sets the limit to 2 decides what the next test's composer allows.
 * Mirrors `dashboard/paymentAccount.ts`'s own `resetPaymentAccountCacheForTesting`.
 * Never called from application code.
 */
export function resetPostImageLimitForTesting(): void {
  maxPostImages = FALLBACK_MAX_POST_IMAGES;
}

/**
 * A single post as the API renders it — Task 3 declares this shape so
 * `PostCard` has something to import; Task 4 adds the endpoint functions
 * (`createPost`, `listPosts`, ...) that actually resolve one.
 *
 * `createdAt`/`editedAt` stay raw ISO-8601 strings here, same rule as
 * `UserProfileCore.createdAt` above: nothing in this file does date
 * arithmetic, so there is nothing to gain from parsing early and a `Date`
 * object would just be re-serialised at the fetch boundary anyway.
 * `editedAt` is explicitly `null` on a never-edited post, never absent —
 * `PostCard` depends on being able to tell "not edited" from "field missing"
 * without an `in` check.
 *
 * Deliberately NO `viewerFollows` and no follow state of any kind: a post
 * card renders one author's name and handle, not a relationship to them, and
 * this project already lost a review round to that field getting guessed
 * back into existence (`false` when signed out) in exactly this kind of
 * component. See `PostCard.tsx`'s own docstring.
 */
export interface PostView {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  author: {
    handle: string;
    displayName: string;
  };
  /**
   * The post's images, in `position` order. REQUIRED and `[]` on a post with
   * none, never absent — the API states that guarantee explicitly (`toPostView`
   * takes `media` rather than defaulting it), and the type stays honest about
   * what a healthy API returns.
   *
   * **Both readers DO write `?? []` over it anyway, and that is deliberate**
   * (`PostCard.tsx`, `postOwnerActions.tsx`). The guarantee holds for this
   * branch's API and not for the seconds of a deploy where one side is the
   * previous release; a bare `.length` there is an uncaught render throw with
   * no error boundary anywhere in this app. See `PostCard.tsx`'s own comment on
   * the media slot for the full reasoning. This docstring used to claim neither
   * reader guarded the field, which stopped being true in the same fix round
   * that added the guards.
   */
  media: MediaView[];
}

/** One keyset page of posts — `nextCursor` is `null` on the last page, never absent. */
export interface FeedPage {
  posts: PostView[];
  nextCursor: string | null;
}

/**
 * `untuk-anda` is PUBLIC, `mengikuti` is not — hence two different helpers for
 * one endpoint.
 *
 * `publicGet` sends the viewer's token when there is one and never clears the
 * session on a 401; `apiFetch` does clear it. `mengikuti` genuinely requires a
 * live session, so a 401 there means the token is dead and clearing it is right.
 * `untuk-anda` must keep working with no session at all, because `/beranda` is a
 * publicly reachable page.
 */
export function listFeed(tab: "untuk-anda" | "mengikuti", before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams({ tab });
  if (before !== undefined && before !== null) params.set("before", before);
  const path = `/users/feed?${params.toString()}`;
  return tab === "mengikuti"
    ? apiFetch<FeedPage>(path)
    : publicGet<FeedPage>(path, "gagal memuat kiriman");
}

/** `GET /:handle/posts` — public, backs both Beranda's search-in-profile use and the profile page itself. */
export function listUserPosts(handle: string, before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams();
  if (before !== undefined && before !== null) params.set("before", before);
  const search = params.toString();
  return publicGet<FeedPage>(
    `/users/${encodeURIComponent(handle)}/posts${search === "" ? "" : `?${search}`}`,
    "gagal memuat kiriman"
  );
}

/**
 * `POST /users/posts` (201). Requires a live session, same as every other
 * `apiFetch` call.
 *
 * `mediaIds` is the images this post carries, in the order they should appear
 * (`position` IS the array's order, spec §5.2). **Omitted entirely when the
 * caller passes nothing**, rather than sent as `[]`: the two are the same thing
 * on `POST`, but they are NOT on `PATCH` (see `editPost`), and one rule for both
 * keeps the distinction where it is real instead of teaching this file that an
 * empty list and no list are interchangeable.
 */
export function createPost(body: string, mediaIds?: string[]): Promise<PostView> {
  return apiFetch<PostView>("/users/posts", {
    method: "POST",
    body: JSON.stringify(mediaIds === undefined ? { body } : { body, mediaIds }),
  });
}

/**
 * `PATCH /users/posts/:id`.
 *
 * **`mediaIds` is the COMPLETE desired list, not a delta** (spec §5.2): the
 * images the post should carry when the request finishes, in the order they
 * should appear. So the two empty cases are genuinely different and both are
 * reachable from here — an explicit `[]` REMOVES every image, while omitting
 * the key leaves the post's images exactly as they were, which is what a
 * text-only edit sends.
 */
export function editPost(id: string, body: string, mediaIds?: string[]): Promise<PostView> {
  return apiFetch<PostView>(`/users/posts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(mediaIds === undefined ? { body } : { body, mediaIds }),
  });
}

/** `DELETE /users/posts/:id` — idempotent 200. */
export function deletePost(id: string): Promise<void> {
  return apiFetch<void>(`/users/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
}
