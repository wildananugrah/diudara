import { apiFetch, DashboardApiError } from "./apiClient";
import { getCreator, notifyAuthChange } from "./auth";

/**
 * WHETHER THIS CREATOR CAN TAKE MONEY, as the SERVER knows it.
 *
 * This used to be guessed from `localStorage`, because no endpoint reported
 * payment-account state: a creator who connected on a laptop still looked
 * unconnected on their phone. `GET /payment-account` (apps/api's
 * `GetPaymentAccountStatus`) closed that gap by reading
 * `creator.xendit_account_id` on the server, so this module now caches THE
 * SERVER'S ANSWER in memory rather than one browser's memory of its own past
 * POSTs.
 *
 * Three states, matching the column's three states 1:1 (see
 * apps/api/src/domain/payment-account.ts):
 *
 *   "connected"     — `isConnectedPaymentAccount` — money can settle.
 *   "provisioning"  — `isProvisioningPlaceholder` — a connect attempt (from
 *                      ANY device) is claimed but not finished.
 *   "not_connected" — neither of the above, including "the GET has not
 *                      answered yet or failed" — this fails towards SHOWING
 *                      the warning, the same direction the old localStorage
 *                      design failed in for its "unknown" state.
 *
 * PROBING WITH `POST /payment-account` IS STILL NOT AN OPTION and this module
 * never calls it — see `CreatePaymentAccount`'s docstring for why: it
 * provisions a Xendit MANAGED sub-account, a KYC entity with no delete
 * endpoint. Only a person pressing "Hubungkan pembayaran" on `AccountPage`
 * may call the POST; this module only ever GETs, and only when nothing is
 * known yet.
 *
 * KEYED BY CREATOR ID, in memory, for the same reason the old localStorage key
 * was: two creators can share a browser, and one's connected account must
 * never suppress — or, now, leak into — the other's.
 */
export type PaymentAccountState = "loading" | "connected" | "provisioning" | "not_connected";

interface PaymentAccountStatusResponse {
  connected: boolean;
  provisioning: boolean;
  /** Absent on an older server; see `paymentsAvailable` below for the default. */
  available?: boolean;
}

/**
 * WHETHER THIS SERVER HAS A PAYMENT PROVIDER AT ALL — a property of the
 * deployment, not of the creator, which is why it is a module-level value and
 * not keyed by creator id the way the cache above is.
 *
 * Comes from `GET /payment-account`'s `available`, which the route derives from
 * the same `createPaymentAccount !== undefined` that makes its own POST answer
 * 503. Needed because `connected: false, provisioning: false` on its own is
 * ambiguous: "you have not connected yet" and "there is nothing here to connect
 * to" look identical, and only the first is fixable by pressing a button.
 *
 * FAILS TOWARD "AVAILABLE" — the OPPOSITE direction from `PaymentAccountNotice`,
 * and deliberately so. The only consumer is `CreateCommunityForm`, which uses it
 * to decide whether to OFFER a paid community. Wrongly hiding that option on a
 * box where payments work would stop a creator making the community they came to
 * make, with no error to explain it; wrongly offering it on a box where they do
 * not costs one 409 whose message is already Indonesian and already says exactly
 * what happened. Between an unexplained missing option and a clear refusal, the
 * clear refusal is the better failure.
 */
let paymentsAvailable: "unknown" | "available" | "unavailable" = "unknown";

/** `useSyncExternalStore`'s snapshot for `paymentsAvailable`. Never fetches. */
export function getPaymentsAvailable(): "unknown" | "available" | "unavailable" {
  return paymentsAvailable;
}

function fromResponse(body: PaymentAccountStatusResponse): PaymentAccountState {
  if (body.connected) return "connected";
  if (body.provisioning) return "provisioning";
  return "not_connected";
}

let cacheByCreator = new Map<string, PaymentAccountState>();
/**
 * Bumped on every write this module makes for ANY creator, and captured by
 * `ensurePaymentAccountStatusLoaded` before its GET goes out. If the number has
 * moved by the time the GET answers, something more authoritative — a
 * `recordPaymentAccountState` from a POST that just succeeded, most likely —
 * arrived first, and the GET's answer is DROPPED rather than applied. Without
 * this, a slow GET started on mount could land after a creator pressed
 * "Hubungkan pembayaran" and flip a just-cleared warning back on.
 */
let generation = 0;
let inFlight: Promise<void> | null = null;

function currentCreatorId(): string | null {
  return getCreator()?.id ?? null;
}

function setCached(creatorId: string, next: PaymentAccountState): void {
  generation += 1;
  if (cacheByCreator.get(creatorId) === next) return;
  cacheByCreator.set(creatorId, next);
  // See auth.ts's `notifyAuthChange` docstring: one notifier, reused, so a
  // component subscribed to session changes also hears about this.
  notifyAuthChange();
}

/** `useSyncExternalStore`'s snapshot function. Never throws, never fetches. */
export function getPaymentAccountState(): PaymentAccountState {
  const id = currentCreatorId();
  if (id === null) return "loading";
  return cacheByCreator.get(id) ?? "loading";
}

/**
 * Starts the ONE `GET /payment-account` this creator's session needs, unless
 * the answer is already known (for this creator) or a request for it is
 * already in flight.
 *
 * Safe to call from every mounted copy of `PaymentAccountNotice` and from
 * `AccountPage` on every render — the in-flight and "already known" guards
 * mean N callers cost at most ONE request, and a resolved answer costs none.
 */
export function ensurePaymentAccountStatusLoaded(): void {
  const id = currentCreatorId();
  if (id === null || inFlight !== null) return;
  if ((cacheByCreator.get(id) ?? "loading") !== "loading") return;

  const startedGeneration = generation;
  inFlight = apiFetch<PaymentAccountStatusResponse>("/payment-account")
    .then((body) => {
      if (generation !== startedGeneration || currentCreatorId() !== id) return;
      // `available` is a server fact, so it is recorded even though the
      // per-creator cache below is guarded — but only when the response
      // actually carried it. An older server omits the field, and treating a
      // missing key as `false` would silently hide the paid option everywhere.
      if (typeof body.available === "boolean") {
        paymentsAvailable = body.available ? "available" : "unavailable";
      }
      setCached(id, fromResponse(body));
    })
    .catch((err) => {
      // A 401 already cleared the session (see apiClient.ts) and a redirect to
      // login is in flight; nothing to record for a creator who is no longer
      // signed in.
      if (err instanceof DashboardApiError && err.status === 401) return;
      if (generation !== startedGeneration || currentCreatorId() !== id) return;
      setCached(id, "not_connected");
    })
    .finally(() => {
      inFlight = null;
    });
}

/**
 * Records what a `POST /payment-account` attempt just learned, THEN TELLS
 * EVERY MOUNTED SCREEN — immediately, and without waiting for a re-fetch.
 *
 * See `PaymentAccountNotice`'s docstring in `ui.tsx` for why the notification
 * is not a nicety: it renders on the communities list and the tier editor,
 * both of which can be mounted while the creator presses "Hubungkan
 * pembayaran" on the account screen.
 */
export function recordPaymentAccountState(state: PaymentAccountState): void {
  const id = currentCreatorId();
  if (id === null) return;
  setCached(id, state);
}

/**
 * Reads `POST /payment-account`'s 409 message.
 *
 * Matched on the API's own wording (see `CreatePaymentAccount.alreadyClaimed`),
 * which is the only signal on the wire for THAT route — the endpoint returns
 * `{ error }` and no code. `startsWith`-style substring matching rather than
 * equality so a later suffix does not silently misclassify; an unrecognised
 * 409 is treated as `not_connected`, which fails towards showing the warning.
 */
export function paymentAccountStateFromConflict(message: string): PaymentAccountState {
  if (message.includes("already connected")) return "connected";
  if (message.includes("already in progress")) return "provisioning";
  return "not_connected";
}

/**
 * TEST-ONLY. Resets the module-level cache between tests — this module is a
 * singleton for the lifetime of the page (or the test file), so without this
 * one test's `recordPaymentAccountState` call would leak into the next.
 * Never called from application code.
 */
export function resetPaymentAccountCacheForTesting(): void {
  cacheByCreator = new Map();
  generation = 0;
  inFlight = null;
  paymentsAvailable = "unknown";
}
