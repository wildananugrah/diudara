import type { StartCheckoutInput } from "@diudara/shared";

// Mirrors apps/api/src/application/use-cases/get-public-community.ts and
// start-checkout.ts. Those response shapes are not (yet) exported from
// @diudara/shared — only the request schema (StartCheckoutInput, imported
// above) lives there today — so they are declared here rather than invented
// differently on each side. If a response type is ever added to the shared
// package, these should be replaced with an import instead of kept in sync
// by hand.
export interface PublicTier {
  id: string;
  name: string;
  priceAmount: number;
  billingCycle: string;
}

export interface PublicCommunity {
  id: string;
  name: string;
  niche: string | null;
  slug: string;
  acceptingNewMembers: boolean;
  tiers: PublicTier[];
}

export interface CheckoutResult {
  invoiceUrl: string;
  subscriptionId: string;
  transactionId: string;
}

/**
 * Mirrors apps/api/src/application/use-cases/get-subscription-status.ts.
 * `status` is the only field the endpoint ALWAYS returns — see that file and
 * routes/public-subscription.ts for why: the subscription id travels in a
 * public, unauthenticated URL. `watchUrl` is the one narrow exception
 * (Task 8): a `/watch/<token>` path, present only while this member's
 * subscription is active AND their community has a live event right now.
 */
export interface SubscriptionStatus {
  status: string;
  watchUrl?: string;
}

/** Mirrors apps/api/src/application/use-cases/resolve-watch-token.ts's success shape. */
export interface WatchSession {
  hlsUrl: string;
}

/** Thrown for any non-2xx response from the API. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The error handler always responds with `{ error: "..." }` (see apps/api/src/http/error-handler.ts). */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Body wasn't JSON (or was empty) — fall back below.
  }
  return fallback;
}

export async function fetchCommunity(slug: string): Promise<PublicCommunity> {
  const res = await fetch(`/c/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    throw new ApiError(await readErrorMessage(res, `failed to load community (${res.status})`), res.status);
  }
  return (await res.json()) as PublicCommunity;
}

export async function startCheckout(slug: string, input: StartCheckoutInput): Promise<CheckoutResult> {
  const res = await fetch(`/c/${encodeURIComponent(slug)}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ApiError(await readErrorMessage(res, `checkout failed (${res.status})`), res.status);
  }
  return (await res.json()) as CheckoutResult;
}

export async function fetchSubscriptionStatus(subscriptionId: string): Promise<SubscriptionStatus> {
  const res = await fetch(`/c/subscription/${encodeURIComponent(subscriptionId)}/status`);
  if (!res.ok) {
    throw new ApiError(await readErrorMessage(res, `failed to load status (${res.status})`), res.status);
  }
  return (await res.json()) as SubscriptionStatus;
}

/**
 * Resolves a `/watch/<token>` token into the HLS URL `hls.js` should load —
 * see apps/api/src/application/use-cases/resolve-watch-token.ts. Every
 * refusal reason (expired, malformed, wrong community, an inactive
 * subscription, streaming not configured) answers with the SAME 403 body
 * — `WatchPage` never reads `error` out of it and never should, so this
 * function does not bother returning it either; the one Indonesian message
 * the page shows for any `ApiError` here is deliberately uninformative
 * about which of those it was.
 */
export async function fetchWatchSession(token: string): Promise<WatchSession> {
  const res = await fetch(`/c/watch/${encodeURIComponent(token)}`);
  if (!res.ok) {
    throw new ApiError(`watch link is no longer valid (${res.status})`, res.status);
  }
  return (await res.json()) as WatchSession;
}

/**
 * Formats an integer-Rupiah amount for Indonesian readers, e.g. 50000 -> "Rp 50.000".
 * Never do arithmetic on the formatted string — this is display-only.
 */
export function formatRupiah(amount: number): string {
  return `Rp ${Math.trunc(amount).toLocaleString("id-ID")}`;
}
