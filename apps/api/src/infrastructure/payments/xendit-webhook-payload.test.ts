import { describe, expect, it } from "bun:test";
import { ValidationError } from "../../application/errors";
import { parseXenditInvoiceCallback } from "./xendit-webhook-payload";

function body(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv_65a1b2c3",
    external_id: "3f1c9e0a-1111-4222-8333-444455556666",
    status: "PAID",
    amount: 50000,
    ...overrides,
  };
}

describe("parseXenditInvoiceCallback", () => {
  it("extracts the fields the handler needs", () => {
    const parsed = parseXenditInvoiceCallback(body());

    expect(parsed.invoiceId).toBe("inv_65a1b2c3");
    expect(parsed.externalId).toBe("3f1c9e0a-1111-4222-8333-444455556666");
    expect(parsed.status).toBe("PAID");
    expect(parsed.amount).toBe(50000);
    expect(parsed.eventType).toBe("invoice.paid");
  });

  describe("provider_event_id", () => {
    it("is stable across a retry of the SAME delivery", () => {
      // Xendit retries a failed callback with a byte-identical body. Both must
      // produce one key or the replay guard never fires.
      expect(parseXenditInvoiceCallback(body()).providerEventId).toBe(
        parseXenditInvoiceCallback(body()).providerEventId
      );
    });

    it("DIFFERS between paid and expired for the same invoice", () => {
      // The handoff hazard: keying on the invoice id alone would make a
      // legitimate invoice.expired arriving after invoice.paid look like a
      // replay, and it would be silently swallowed.
      const paid = parseXenditInvoiceCallback(body({ status: "PAID" })).providerEventId;
      const expired = parseXenditInvoiceCallback(body({ status: "EXPIRED" })).providerEventId;

      expect(paid).not.toBe(expired);
    });

    it("differs between two invoices in the same state", () => {
      const a = parseXenditInvoiceCallback(body({ id: "inv_a" })).providerEventId;
      const b = parseXenditInvoiceCallback(body({ id: "inv_b" })).providerEventId;

      expect(a).not.toBe(b);
    });

    it("derives from the invoice id and status, not from our own external id", () => {
      // Our external id is the transaction id, which is per-checkout, not
      // per-delivery — two events for one checkout share it by definition.
      const parsed = parseXenditInvoiceCallback(body());
      expect(parsed.providerEventId).toContain("inv_65a1b2c3");
      expect(parsed.providerEventId).toContain("PAID");
      expect(parsed.providerEventId).not.toContain("3f1c9e0a");
    });

    it("stays inside the provider_event_id column's 255 characters", () => {
      const parsed = parseXenditInvoiceCallback(body());
      expect(parsed.providerEventId.length).toBeLessThanOrEqual(255);
    });
  });

  describe("rejects a body it cannot trust", () => {
    it("rejects a non-object body", () => {
      for (const bad of [null, undefined, "PAID", 42, []]) {
        expect(() => parseXenditInvoiceCallback(bad)).toThrow(ValidationError);
      }
    });

    it("rejects a missing or empty invoice id", () => {
      // Without this, every malformed delivery would collapse onto one
      // provider_event_id of ":PAID" and the second would be treated as a replay.
      for (const bad of [undefined, "", "   ", 12345, null]) {
        expect(() => parseXenditInvoiceCallback(body({ id: bad }))).toThrow(ValidationError);
      }
    });

    it("rejects a missing external id", () => {
      for (const bad of [undefined, "", "   ", null, { nested: true }]) {
        expect(() => parseXenditInvoiceCallback(body({ external_id: bad }))).toThrow(
          ValidationError
        );
      }
    });

    it("rejects a missing status", () => {
      for (const bad of [undefined, "", null, 7]) {
        expect(() => parseXenditInvoiceCallback(body({ status: bad }))).toThrow(ValidationError);
      }
    });

    it("rejects an amount that is not a non-negative integer", () => {
      // `Number(body.amount ?? -1)` would turn a missing amount into -1 and a
      // string "50000" into 50000. Neither is a number we should compare money
      // against; both are rejected here so the mismatch check works on a real
      // number.
      for (const bad of [undefined, null, "50000", Number.NaN, Infinity, -1, 1.5, {}]) {
        expect(() => parseXenditInvoiceCallback(body({ amount: bad }))).toThrow(ValidationError);
      }
    });

    it("rejects oversized strings that would overflow their columns", () => {
      // varchar(255) on provider_event_id and varchar(64) on event_type: an
      // attacker-chosen 10,000-character status would otherwise become a
      // 22001 driver error, i.e. a 500 with a query in the log.
      expect(() => parseXenditInvoiceCallback(body({ id: "x".repeat(500) }))).toThrow(
        ValidationError
      );
      expect(() => parseXenditInvoiceCallback(body({ status: "P".repeat(500) }))).toThrow(
        ValidationError
      );
      expect(() => parseXenditInvoiceCallback(body({ external_id: "x".repeat(500) }))).toThrow(
        ValidationError
      );
    });

    it("does not put any part of the body into the error message", () => {
      // A Xendit callback carries payer_email and payer name. The error message
      // reaches the HTTP response and the logs.
      const error = (() => {
        try {
          parseXenditInvoiceCallback({
            ...body({ amount: "nope" }),
            payer_email: "siti@example.com",
          });
          return null;
        } catch (e) {
          return e as Error;
        }
      })();

      expect(error).toBeInstanceOf(ValidationError);
      expect(error!.message).not.toContain("siti@example.com");
      expect(error!.message).not.toContain("nope");
    });
  });

  it("lower-cases the status into a namespaced event type", () => {
    expect(parseXenditInvoiceCallback(body({ status: "EXPIRED" })).eventType).toBe(
      "invoice.expired"
    );
    expect(parseXenditInvoiceCallback(body({ status: "SETTLED" })).eventType).toBe(
      "invoice.settled"
    );
  });
});

/**
 * The parser reads FIVE fields and ignores every other key in the body.
 *
 * That is not laxity, it is the rule that keeps a genuine payment from being
 * refused: a `ValidationError` for an unexpected or unusable field would 400 a
 * real PAID callback, and the member who paid would never be activated. Xendit
 * sends a large body and adds to it over time, and the whole thing is kept
 * verbatim on `webhook_event.payload` anyway.
 *
 * Retire-telegram Task 5 removed the one field that used to be read beyond those
 * five, `payment_method` — captured for `transaction.payment_method`, a column
 * on a table the deleted community dashboard read. `user_transaction` has no
 * such column, so it was a value nothing could consume.
 */
describe("parseXenditInvoiceCallback — everything else in the body", () => {
  const base = { id: "inv_1", external_id: "txn-1", status: "PAID", amount: 50000 };

  it("NEVER throws on an extra or unusable field — it ignores it", () => {
    for (const extra of [
      { payment_method: "" },
      { payment_method: 42 },
      { payment_method: "A_VERY_LONG_PAYMENT_METHOD_NAME" },
      { payment_channel: "BCA" },
      { payer_email: "siti@example.com", payer_name: "Siti" },
      { paid_at: "2026-08-09T11:00:00Z" },
      { something_xendit_adds_next_year: { nested: true } },
    ]) {
      const event = parseXenditInvoiceCallback({ ...base, ...extra });
      // The fields that DO authorise things are untouched, and nothing threw.
      expect(event.amount).toBe(50000);
      expect(event.invoiceId).toBe("inv_1");
      expect(event.externalId).toBe("txn-1");
      expect(event.status).toBe("PAID");
    }
  });
});
