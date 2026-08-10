/**
 * The creator's session, as the browser holds it.
 *
 * The JWT lives in `localStorage` and goes out as `Authorization: Bearer`. It is
 * NEVER logged, NEVER put in a URL, and NEVER rendered — see `apiClient.ts` for
 * the request side and the `never renders the token` tests for the DOM side. The
 * one place it is written is here.
 *
 * THIS MODULE IS ALSO AN EVENT SOURCE, and that is what makes a stale token
 * recoverable rather than fatal. The token is good for seven days; when it
 * expires, the next call from any panel gets a 401, `apiClient` calls
 * `clearToken()`, and every `RequireAuth` subscribed here re-renders and
 * redirects to login. Without the notification the panel would sit there
 * erroring with no way out — the most confusing possible state — because nothing
 * re-reads `localStorage` on its own.
 */

/** The ONE key the token lives under, exported so tests assert on it rather than guess. */
export const TOKEN_STORAGE_KEY = "diudara.dashboard.token";

/**
 * The creator's own name and email, cached so the header can greet them without
 * an extra request. Not sensitive in the way the token is — but it is still
 * cleared with the token, because half a session left behind is a bug.
 */
const CREATOR_STORAGE_KEY = "diudara.dashboard.creator";

export interface DashboardCreator {
  id: string;
  name: string;
  email: string | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  // A copy: a listener that unsubscribes itself while being notified would
  // otherwise mutate the set mid-iteration.
  for (const listener of [...listeners]) listener();
}

/**
 * Announces that something about this browser's session changed.
 *
 * Exported for `paymentAccount.ts`, which stores a second piece of per-session
 * browser state under its own key and has exactly the same problem this module
 * solves: nothing re-reads `localStorage` on its own, so a screen that read the
 * value during render kept showing the stale one until something unrelated
 * re-rendered it. One notifier rather than two, because there is one thing
 * observers actually want to know — "re-read what you cached about this session" —
 * and a component subscribing to both would just re-render twice.
 */
export function notifyAuthChange(): void {
  notify();
}

/**
 * Subscribes to session changes. Returns the unsubscribe function, in the shape
 * `useSyncExternalStore` expects.
 */
export function subscribeToAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToken(): string | null {
  // `localStorage` throws in a browser with storage disabled (Safari private
  // mode, historically). A dashboard that cannot store a session is broken, but
  // it should say "log in" rather than throw during render.
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getCreator(): DashboardCreator | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CREATOR_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, name } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") return null;
    const email = (parsed as Record<string, unknown>).email;
    return { id, name, email: typeof email === "string" ? email : null };
  } catch {
    // Hand-edited in devtools, or written by an older build. Losing the greeting
    // is acceptable; crashing every screen that reads it is not.
    return null;
  }
}

/** Stores the token and the creator together, then notifies. */
export function setSession(token: string, creator: DashboardCreator): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(CREATOR_STORAGE_KEY, JSON.stringify(creator));
  } catch {
    // Storage is unavailable; the session simply will not persist. Notifying
    // anyway is wrong — `getToken()` would still be null and the UI would flicker.
    return;
  }
  notify();
}

/**
 * Ends the session: both keys, then notify.
 *
 * Called on logout AND on any 401. It is deliberately total — a token removed
 * while the cached creator stayed would leave a header greeting somebody who is
 * no longer signed in.
 */
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(CREATOR_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage never worked.
  }
  notify();
}
