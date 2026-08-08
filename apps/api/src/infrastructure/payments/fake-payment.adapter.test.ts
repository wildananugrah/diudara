import { describe, expect, it } from "bun:test";
import { FakePaymentAdapter } from "./fake-payment.adapter";

const INPUT = {
  externalId: "txn-1",
  amount: 50000,
  description: "Basic",
  payerName: "Siti",
  payerWhatsappNumber: "+6281234567890",
  forAccountId: "acct-creator-1",
};

describe("FakePaymentAdapter", () => {
  it("returns an invoice and records which account it was charged to", async () => {
    const adapter = new FakePaymentAdapter();
    const result = await adapter.createInvoice(INPUT);

    expect(result.invoiceId).toBeTruthy();
    expect(result.invoiceUrl).toContain(result.invoiceId);
    expect(adapter.invoices.length).toBe(1);
    expect(adapter.invoices[0].forAccountId).toBe("acct-creator-1");
  });

  it("creates a distinct account id per creator", async () => {
    const adapter = new FakePaymentAdapter();
    const a = await adapter.createPaymentAccount({
      creatorId: "c1", email: "a@example.com", name: "A",
    });
    const b = await adapter.createPaymentAccount({
      creatorId: "c2", email: "b@example.com", name: "B",
    });
    expect(a.accountId).not.toBe(b.accountId);
  });

  it("can be told to fail, so callers' error paths are testable", async () => {
    const adapter = new FakePaymentAdapter();
    adapter.failNextInvoice = true;
    await expect(adapter.createInvoice(INPUT)).rejects.toThrow();
  });
});
