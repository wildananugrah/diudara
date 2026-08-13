import { ApiError } from "../api";
import { clearToken, getToken, setSession, type DashboardCreator } from "./auth";
import type { JoinRequestDecisionResult, JoinRequestRow } from "./types";

/**
 * An error from the dashboard API, with the 400's per-field messages already
 * split out.
 *
 * `fieldErrors` is empty for every status except a validation failure, and can be
 * empty for one of those too — see `parseFieldErrors` for why that is deliberate.
 */
export class DashboardApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly fieldErrors: Readonly<Record<string, string>> = {}
  ) {
    super(message, status);
    this.name = "DashboardApiError";
  }
}

/**
 * Splits Phase 2's validation message into `{ field: message }`.
 *
 * THE SHAPE, MEASURED RATHER THAN ASSUMED. The plan says the API "returns Zod
 * issues in a shape the UI can render field-level messages from"; what
 * `http/validate.ts` actually sends is ONE STRING —
 * `issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")` —
 * inside `{ error }`. There are no structured issues on the wire. So this parses
 * that string, and it is written to fail safe rather than to be clever:
 *
 *  - a segment is only treated as a field when the text before the first `": "`
 *    looks like an identifier path (`priceAmount`, `patch.slug`). Anything with
 *    spaces — `"invalid page parameters: limit must be…"` — is a whole-message
 *    error, not a field called "invalid page parameters".
 *  - `"body"` is Zod's placeholder for an object-level refinement (`at least one
 *    field is required`). There is no input named `body`, so it stays general.
 *  - when nothing parses, the caller still has `err.message`. Every form renders
 *    the general message as well as the field ones, so a message can never be
 *    swallowed by a parse that did not match.
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
    // The last path segment: the API reports `patch.slug` but the form's input is
    // named `slug`. First writer wins so a nested duplicate cannot overwrite it.
    const field = path.slice(path.lastIndexOf(".") + 1);
    if (!(field in fieldErrors)) fieldErrors[field] = detail;
  }
  return fieldErrors;
}

/** The error handler always responds `{ error: "..." }` — see apps/api/src/http/error-handler.ts. */
async function readError(res: Response, fallback: string): Promise<DashboardApiError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) message = body.error;
  } catch {
    // Not JSON (a proxy error page, an empty body) — keep the fallback.
  }
  return new DashboardApiError(
    message,
    res.status,
    res.status === 400 ? parseFieldErrors(message) : {}
  );
}

/** Message shown when the session is gone. Never mentions the token itself. */
export const SESSION_EXPIRED_MESSAGE = "Sesi Anda sudah berakhir. Silakan masuk kembali.";

function authorizedHeaders(init: RequestInit | undefined, token: string | null): Headers {
  const headers = new Headers(init?.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  // Set here rather than at every call site, so no request can forget it and get
  // a confusing "request body must be valid JSON" back from a body it did send.
  if (init?.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

/**
 * One authenticated request, returning the raw `Response`.
 *
 * ON ANY 401 IT CLEARS THE TOKEN. That is the whole reason every screen goes
 * through this function instead of calling `fetch` itself: the token is valid for
 * seven days, and when it expires there is nothing to tell the UI except the next
 * 401. Clearing it notifies `auth.ts`'s subscribers, and the `RequireAuth` around
 * the current screen redirects to login (see `RequireAuth.tsx`) — a router
 * navigation rather than a full page load, so nothing half-rendered survives.
 *
 * It is deliberately NOT a `window.location` assignment: that would reload the app
 * on every expiry and is untestable under happy-dom, and it would also fire from
 * the login page itself.
 */
export async function apiRequest(path: string, init?: RequestInit): Promise<Response> {
  // Read at call time, never captured at module load: a token set moments ago by
  // login, or cleared moments ago by a 401, must be the one that is used.
  const res = await fetch(path, { ...init, headers: authorizedHeaders(init, getToken()) });
  if (res.status === 401) {
    clearToken();
    throw new DashboardApiError(SESSION_EXPIRED_MESSAGE, 401);
  }
  return res;
}

/** One authenticated request whose JSON body is the result. Throws on any non-2xx. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiRequest(path, init);
  if (!res.ok) {
    throw await readError(res, `permintaan gagal (${res.status})`);
  }
  // 204 has no body; nothing in the dashboard reads one from a 204 today, and
  // `undefined as T` is honest about that rather than throwing on empty text.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface AuthSuccess {
  creator: DashboardCreator;
  token: string;
}

/**
 * `POST /auth/login` and `POST /auth/signup`.
 *
 * DELIBERATELY OUTSIDE `apiRequest`, for two reasons that both matter:
 *
 *  1. A stale token must not travel with the credentials meant to replace it.
 *  2. Login's own 401 is "wrong password", NOT "session expired". Routing it
 *     through the interceptor would clear a session the creator may still be
 *     holding in another tab, and would show them the wrong message.
 */
async function authenticate(path: string, body: unknown): Promise<AuthSuccess> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await readError(res, `gagal masuk (${res.status})`);
  }
  const result = (await res.json()) as AuthSuccess;
  setSession(result.token, result.creator);
  return result;
}

export function login(input: { email: string; password: string }): Promise<AuthSuccess> {
  return authenticate("/auth/login", input);
}

export function signup(input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthSuccess> {
  return authenticate("/auth/signup", input);
}

/** `GET /communities/:communityId/join-requests` — pending free-community requests only. */
export function listJoinRequests(communityId: string): Promise<JoinRequestRow[]> {
  return apiFetch<JoinRequestRow[]>(`/communities/${communityId}/join-requests`);
}

/**
 * `POST /communities/:communityId/join-requests/:requestId/approve`.
 *
 * Answers 404 for a non-owner — never 403, so a stranger cannot learn the
 * community or the request exists — and 409 when the request was already
 * decided, most often because the owner has this page open in another tab.
 * Both surface as an ordinary `DashboardApiError`; `MembersPage.tsx` decides
 * what each means on screen.
 */
export function approveJoinRequest(
  communityId: string,
  requestId: string
): Promise<JoinRequestDecisionResult> {
  return apiFetch<JoinRequestDecisionResult>(
    `/communities/${communityId}/join-requests/${requestId}/approve`,
    { method: "POST" }
  );
}

/** Same contract as `approveJoinRequest`, for the other decision. */
export function rejectJoinRequest(
  communityId: string,
  requestId: string
): Promise<JoinRequestDecisionResult> {
  return apiFetch<JoinRequestDecisionResult>(
    `/communities/${communityId}/join-requests/${requestId}/reject`,
    { method: "POST" }
  );
}
