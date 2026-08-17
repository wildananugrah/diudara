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

/** Stores the token and the account together, then notifies. */
export function setUserSession(token: string, user: SessionUser): void {
  try {
    localStorage.setItem(USER_TOKEN_STORAGE_KEY, token);
    localStorage.setItem(USER_ACCOUNT_STORAGE_KEY, JSON.stringify(user));
  } catch {
    // Storage is unavailable; the session simply will not persist. Notifying
    // anyway is wrong — `getUserToken()` would still be null and the UI
    // would flicker.
    return;
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
 * `GET /users/by-handle/:handle`. Public — no auth, and deliberately not
 * routed through `apiRequest`: attaching a stale Authorization header to a
 * request nothing checks would be pointless, and a signed-out visitor must
 * be able to browse a profile at all.
 */
export interface PublicUserProfile {
  handle: string;
  displayName: string;
  bio: string | null;
  /** ISO-8601, as it comes off the wire — never parsed to a `Date` here, since nothing on this page does arithmetic on it. */
  createdAt: string;
}

export async function getProfileByHandle(handle: string): Promise<PublicUserProfile> {
  const res = await fetch(`/users/by-handle/${encodeURIComponent(handle)}`);
  if (!res.ok) {
    throw await readError(res, `gagal memuat profil (${res.status})`);
  }
  return (await res.json()) as PublicUserProfile;
}

/** `GET /users/me`'s shape — the public profile plus the caller's own email and WhatsApp number. */
export interface OwnUserProfile extends PublicUserProfile {
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
