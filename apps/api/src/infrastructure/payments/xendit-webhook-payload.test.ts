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
 * MINOR, final whole-branch review: the callback's `payment_method` was
 * discarded and every transaction kept the literal "invoice" StartCheckout
 * created it with. The dashboard phase needs to know how members actually pay.
 */
describe("parseXenditInvoiceCallback — payment_method", () => {
  const base = { id: "inv_1", external_id: "txn-1", status: "PAID", amount: 50000 };

  it("captures the method the callback reports", () => {
    expect(parseXenditInvoiceCallback({ ...base, payment_method: "BANK_TRANSFER" }).paymentMethod)
      .toBe("BANK_TRANSFER");
    expect(parseXenditInvoiceCallback({ ...base, payment_method: "  EWALLET  " }).paymentMethod)
      .toBe("EWALLET");
  });

  it("is undefined when the callback does not report one", () => {
    expect(parseXenditInvoiceCallback(base).paymentMethod).toBeUndefined();
  });

  /**
   * The whole point of it being optional. A ValidationError here would 400 a
   * GENUINE paid callback, so a member who really paid would never be activated
   * — an absurd price for a display string. The amount and the invoice id are
   * what authorise anything; this is decoration.
   */
  it("NEVER throws on an unusable value — it degrades to undefined", () => {
    for (const unusable of [
      "",
      "   ",
      42,
      null,
      { code: "BANK_TRANSFER" },
      ["BANK_TRANSFER"],
      // Longer than transaction.payment_method's varchar(16), which would
      // otherwise be SQLSTATE 22001 from the driver — a 500 on a real payment.
      "A_VERY_LONG_PAYMENT_METHOD_NAME",
      "x".repeat(17),
    ]) {
      const event = parseXenditInvoiceCallback({ ...base, payment_method: unusable });
      expect(event.paymentMethod).toBeUndefined();
      // ...and the fields that DO authorise things are untouched.
      expect(event.amount).toBe(50000);
      expect(event.invoiceId).toBe("inv_1");
    }
  });

  it("accepts exactly 16 characters, the column's width", () => {
    expect(
      parseXenditInvoiceCallback({ ...base, payment_method: "x".repeat(16) }).paymentMethod
    ).toBe("x".repeat(16));
  });
});
