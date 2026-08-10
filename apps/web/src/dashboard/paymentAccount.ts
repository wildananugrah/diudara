import { getCreator, notifyAuthChange } from "./auth";

/**
 * WHETHER THIS CREATOR CAN TAKE MONEY — as far as the browser is able to know.
 *
 * ================= A GAP IN THE API, RECORDED HONESTLY =================
 * There is NO endpoint that reports payment-account state. `POST /payment-account`
 * is the only route on it; `creator.xendit_account_id` is read by
 * `StartCheckout` and by `CreatePaymentAccount` and is never returned to a client
 * — not by `POST /auth/login`, not by `GET /communities`.
 *
 * So this module records what THIS BROWSER has observed, and nothing more:
 *
 *   "connected"   — a POST answered 201, or answered 409 "already connected".
 *   "in_progress" — a POST answered 409 "connection is already in progress".
 *   "unknown"     — nothing has been observed here. NOT "not connected".
 *
 * The distinction between `unknown` and "not connected" is the whole reason this
 * is a tri-state and not a boolean. A creator who connected payments last month on
 * their laptop and opens the dashboard on their phone is CONNECTED, and a UI that
 * told them "payments are not connected" would be lying to them. So the notice
 * says what is true — that this browser has no confirmation — and tells them the
 * one safe way to find out: press "Hubungkan pembayaran", which answers "sudah
 * terhubung" if it is already done.
 *
 * PROBING WITH A POST IS NOT AN OPTION and must never be added. If the account is
 * absent, that request CREATES a Xendit MANAGED sub-account — a KYC entity with no
 * delete endpoint — so an automatic probe on page load would permanently provision
 * accounts for creators who never asked. It has to be a button a person presses.
 *
 * What would fix this properly: a `GET /payment-account` returning
 * `{ connected: boolean }` (or `xenditAccountId` on the login/`GET /communities`
 * response). Escalated in the task report rather than invented here.
 * =======================================================================
 */
export type PaymentAccountState = "unknown" | "connected" | "in_progress";

/**
 * Per-creator, because two creators can share a browser and one's connected
 * account must never suppress the other's warning.
 */
function storageKey(creatorId: string): string {
  return `diudara.dashboard.payments.${creatorId}`;
}

export function getPaymentAccountState(): PaymentAccountState {
  const creator = getCreator();
  if (creator === null) return "unknown";
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(creator.id));
  } catch {
    return "unknown";
  }
  return raw === "connected" || raw === "in_progress" ? raw : "unknown";
}

/**
 * Writes the observed state, THEN TELLS EVERY MOUNTED SCREEN.
 *
 * The notification is not a nicety. `PaymentAccountNotice` renders on the
 * communities list and on the tier editor, and both can be mounted while the
 * creator presses "Hubungkan pembayaran" on the account screen — so without it the
 * account screen went green while the others carried on telling the same creator
 * that nobody could buy anything, until a navigation happened to re-render them.
 * Nothing re-reads `localStorage` on its own; see the module docstring in
 * `auth.ts`, whose notifier this reuses.
 *
 * Notified even on the failed-write path, deliberately: `getPaymentAccountState`
 * would then answer `unknown` and the warning belongs back on screen. Failing
 * towards showing it is the safe direction, and a listener re-reading and finding
 * nothing changed costs one render.
 */
export function recordPaymentAccountState(state: PaymentAccountState): void {
  const creator = getCreator();
  if (creator === null) return;
  try {
    if (state === "unknown") localStorage.removeItem(storageKey(creator.id));
    else localStorage.setItem(storageKey(creator.id), state);
  } catch {
    // Storage unavailable: the warning simply keeps showing. Harmless, and
    // strictly better than suppressing it on a guess.
  }
  notifyAuthChange();
}

/**
 * Reads `POST /payment-account`'s 409 message.
 *
 * Matched on the API's own wording (see `CreatePaymentAccount.alreadyClaimed`),
 * which is the only signal on the wire — the endpoint returns `{ error }` and no
 * code. `startsWith`-style substring matching rather than equality so a later
 * suffix does not silently flip a connected account back to unknown; and an
 * unrecognised 409 stays `unknown`, which fails towards showing the warning.
 */
export function paymentAccountStateFromConflict(message: string): PaymentAccountState {
  if (message.includes("already connected")) return "connected";
  if (message.includes("already in progress")) return "in_progress";
  return "unknown";
}
