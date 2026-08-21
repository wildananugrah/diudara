import { describe, expect, it } from "bun:test";
import { FakePaymentAdapter } from "./fake-payment.adapter";

const INPUT = {
  externalId: "txn-1",
  amount: 50000,
  description: "Basic",
  payerName: "Siti",
  payerWhatsappNumber: "+6281234567890",
  forAccountId: "acct-creator-1",
  successRedirectUrl: "http://localhost:5173/c/kelas-budi/status/sub-1",
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

  /**
   * The final whole-branch review's I-1: the stale-pending sweep cancels the
   * abandoned invoice when it frees the row, so the fake has to record what it
   * was asked to cancel — a sweep that expired the row and quietly skipped the
   * provider would otherwise look identical from a test.
   */
  it("records the invoices it was asked to expire, with the account they belong to", async () => {
    const adapter = new FakePaymentAdapter();
    const created = await adapter.createInvoice(INPUT);

    await adapter.expireInvoice({ invoiceId: created.invoiceId, forAccountId: "acct-creator-1" });

    expect(adapter.expiredInvoices).toEqual([
      { invoiceId: created.invoiceId, forAccountId: "acct-creator-1" },
    ]);
  });

  it("can be told to fail an expiry, so the sweep's failure path is testable", async () => {
    const adapter = new FakePaymentAdapter();
    adapter.failNextInvoiceExpiry = true;

    await expect(
      adapter.expireInvoice({ invoiceId: "inv-1", forAccountId: "acct-1" })
    ).rejects.toThrow();
    expect(adapter.expiredInvoices).toEqual([]);
    // One-shot, exactly like `failNextInvoice`: the next call works.
    await adapter.expireInvoice({ invoiceId: "inv-1", forAccountId: "acct-1" });
    expect(adapter.expiredInvoices).toHaveLength(1);
  });
});
