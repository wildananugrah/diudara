import { ValidationError } from "../../application/errors";

/** The trusted, shape-checked view of a Xendit invoice callback body. */
export interface XenditInvoiceCallback {
  /**
   * Per-DELIVERY identity for the replay guard. See
   * `deriveProviderEventId` for why this is a composite and not `body.id`.
   */
  providerEventId: string;
  /** Xendit's invoice id. Stored as our `transaction.gateway_reference_id`. */
  invoiceId: string;
  /** OUR transaction id, echoed back by Xendit. Only ever used to look up our own row. */
  externalId: string;
  status: string;
  /**
   * The amount the BODY claims. Never authoritative — the handler compares it
   * against our own `transaction.amount` and rejects any difference.
   */
  amount: number;
  /** `invoice.paid`, `invoice.expired`, … — for `webhook_event.event_type`. */
  eventType: string;
  /**
   * What the callback says the payer actually used (`BANK_TRANSFER`, `EWALLET`,
   * …), for `transaction.payment_method`. `undefined` when absent or unusable —
   * see `optionalPaymentMethod` for why an unusable value must not be an error.
   */
  paymentMethod: string | undefined;
}

/** `provider_event_id` is varchar(255); leave room for the separator and status. */
const MAX_INVOICE_ID_LENGTH = 128;
/** `event_type` is varchar(64), and `invoice.` already spends 8 of it. */
const MAX_STATUS_LENGTH = 32;
/** Our own ids are 36-character uuids; anything longer cannot match one. */
const MAX_EXTERNAL_ID_LENGTH = 128;
/** `transaction.payment_method` is varchar(16) — see db/schema.ts. */
const MAX_PAYMENT_METHOD_LENGTH = 16;

function requireString(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`webhook body field ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`webhook body field ${field} must not be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`webhook body field ${field} is too long`);
  }
  return trimmed;
}

/**
 * Reads `payment_method` — how the payer actually paid — as OPTIONAL, non-fatal
 * metadata.
 *
 * Deliberately never throws. This field is decoration for the creator dashboard
 * (Phase 5); the amount and the invoice id are what authorise anything. A
 * `ValidationError` for an unexpected `payment_method` would mean a 400 on a
 * genuine PAID callback, so a member who really paid would never be activated —
 * an enormous cost for a display string. Anything unusable (missing, not a
 * string, empty, or too long for varchar(16) — which would otherwise be SQLSTATE
 * 22001 from the driver) becomes `undefined`, and the transaction keeps the
 * "invoice" it was created with.
 *
 * `payment_channel` (`BCA`, `OVO`, …) is deliberately NOT captured: there is no
 * column for it, and concatenating it into `payment_method` would overflow
 * varchar(16) for common combinations. It stays available on
 * `webhook_event.payload`, which stores the body verbatim.
 */
function optionalPaymentMethod(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PAYMENT_METHOD_LENGTH) return undefined;
  return trimmed;
}

/**
 * The per-delivery key the UNIQUE constraint on `webhook_event.provider_event_id`
 * arbitrates on.
 *
 * Xendit's invoice callback body has NO per-delivery event id: its `id` field is
 * the INVOICE id, which is stable across every event for that invoice. Keying on
 * it alone would mean a legitimate `invoice.expired` arriving after
 * `invoice.paid` for the same invoice is indistinguishable from a replay, and
 * would be silently swallowed.
 *
 * So the key is `<invoice id>:<status>` — the coarsest thing that is genuinely
 * one-per-event:
 *  - a retry of the same delivery is byte-identical, so it collapses (which is
 *    exactly what the replay guard is for);
 *  - two different lifecycle events for one invoice differ in `status`, so they
 *    stay distinct.
 *
 * Xendit does send a `webhook-id` HTTP header, and it is deliberately NOT used:
 * under a static-token scheme any sender holding the token chooses that header's
 * value freely, so a forger could mint a fresh id to bypass the replay guard, or
 * reuse a pending id to consume the key a genuine delivery needs. Deriving the
 * key from the body fields we independently verify against our own records keeps
 * the guard tied to data an attacker cannot make us accept.
 */
function deriveProviderEventId(invoiceId: string, status: string): string {
  return `${invoiceId}:${status}`;
}

/**
 * Validates an untrusted Xendit callback body into `XenditInvoiceCallback`,
 * throwing `ValidationError` (400) on anything unusable.
 *
 * Coercion is refused rather than performed. `Number(body.amount ?? -1)` would
 * turn a missing amount into `-1` and the string `"50000"` into `50000`; neither
 * is a number we should compare money against, and `-1` in particular is a value
 * chosen to lose the comparison rather than one the sender actually claimed.
 *
 * Lengths are bounded because these strings land in varchar columns:
 * an attacker-chosen 10,000-character `status` would otherwise become SQLSTATE
 * 22001 from the driver — a 500, with the failed statement on the log path.
 *
 * No error message here interpolates a value from the body. A Xendit callback
 * carries `payer_email` and the payer's name, and these messages reach both the
 * HTTP response and the logs.
 */
export function parseXenditInvoiceCallback(body: unknown): XenditInvoiceCallback {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("webhook body must be a json object");
  }

  const raw = body as Record<string, unknown>;
  const invoiceId = requireString(raw.id, MAX_INVOICE_ID_LENGTH, "id");
  const externalId = requireString(raw.external_id, MAX_EXTERNAL_ID_LENGTH, "external_id");
  const status = requireString(raw.status, MAX_STATUS_LENGTH, "status");

  const amount = raw.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    throw new ValidationError("webhook body field amount must be a non-negative integer");
  }

  return {
    providerEventId: deriveProviderEventId(invoiceId, status),
    invoiceId,
    externalId,
    status,
    amount,
    eventType: `invoice.${status.toLowerCase()}`,
    paymentMethod: optionalPaymentMethod(raw.payment_method),
  };
}
