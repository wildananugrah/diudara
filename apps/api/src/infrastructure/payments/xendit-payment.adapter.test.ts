import { describe, expect, it } from "bun:test";
import { XenditPaymentAdapter } from "./xendit-payment.adapter";

function captureFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

const INPUT = {
  externalId: "txn-1",
  amount: 50000,
  description: "Basic",
  payerName: "Siti",
  payerWhatsappNumber: "+6281234567890",
  forAccountId: "acct-creator-1",
};

describe("XenditPaymentAdapter.createInvoice", () => {
  it("charges the creator's sub-account, never the platform", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);

    const headers = calls[0].init.headers as Record<string, string>;
    // for-user-id routes funds to the creator's sub-account. Its absence would
    // settle member money into the platform account — the PJP hazard.
    expect(headers["for-user-id"]).toBe("acct-creator-1");
    expect(headers["with-split-rule"]).toBe("splitrule_1");
  });

  it("sends our external id so the webhook can be matched back", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);

    expect(JSON.parse(calls[0].init.body as string).external_id).toBe("txn-1");
  });

  it("returns the invoice id and url", async () => {
    const { fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    const result = await adapter.createInvoice(INPUT);
    expect(result).toEqual({ invoiceId: "inv_1", invoiceUrl: "https://x/inv_1" });
  });

  it("throws on a non-2xx response without leaking the secret key", async () => {
    const { fetchFn } = captureFetch({ message: "boom" }, 400);
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test_SUPERSECRET", splitRuleId: "splitrule_1", fetchFn,
    });

    // `e` is left untyped (not `e as Error` inline) so `.catch()` collapses to
    // `Promise<any>` instead of `CreateInvoiceResult | Error` — same pattern as
    // authenticate-creator.test.ts. Casting inline breaks `error.message`
    // below under strict mode: TS won't narrow a union from `toBeInstanceOf`.
    const error = (await adapter.createInvoice(INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("sk_test_SUPERSECRET");
  });
});
