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
  successRedirectUrl: "http://localhost:5173/c/kelas-budi/status/sub-1",
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

  // I1, final whole-branch review: without this field the payer never comes back
  // from Xendit, and the confirmation page Task 9 built is unreachable.
  it("sends the success_redirect_url so the payer lands back on our confirmation page", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.success_redirect_url).toBe(INPUT.successRedirectUrl);
    // The subscription id is the only thing the confirmation page can be opened
    // with, so it has to survive into the request.
    expect(body.success_redirect_url).toContain("sub-1");
  });

  it("sends the payer's number when there is one", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);

    expect(JSON.parse(calls[0].init.body as string).customer).toEqual({
      given_names: "Siti",
      mobile_number: "+6281234567890",
    });
  });

  /*
   * Phase 5a fix round 1, F1. `app_user.whatsapp_number` is NULLABLE — signup
   * validates the number with the same regex the community checkout uses and
   * then marks it optional — so a personal-membership buyer may genuinely have
   * none. ABSENT is the documented "no number"; an empty string is a VALUE that
   * still has to pass Xendit's own format validation, and it is a shape nothing
   * in this repository has ever sent. So the key is omitted entirely rather
   * than sent empty.
   */
  it("OMITS mobile_number entirely for a payer with no number, rather than sending an empty string", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice({ ...INPUT, payerWhatsappNumber: undefined });

    const customer = JSON.parse(calls[0].init.body as string).customer;
    expect(customer).toEqual({ given_names: "Siti" });
    expect("mobile_number" in customer).toBe(false);
  });

  // MINOR, final whole-branch review: CheckoutPage assigns this straight to
  // window.location.href. The source is our own API, so the risk is low — but
  // "low" rests entirely on this check.
  it("refuses an invoice_url that is not http(s), which would reach window.location.href", async () => {
    for (const hostile of [
      "javascript:alert(document.domain)",
      "data:text/html,<script>1</script>",
      "//evil.example/inv",
      "inv_1",
    ]) {
      const { fetchFn } = captureFetch({ id: "inv_1", invoice_url: hostile });
      const adapter = new XenditPaymentAdapter({
        secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
      });

      const error = (await adapter.createInvoice(INPUT).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("not an http(s) URL");
    }
  });

  it("accepts http:// as well as https://, for a local stub", async () => {
    const { fetchFn } = captureFetch({ id: "inv_1", invoice_url: "http://localhost:9999/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });
    expect((await adapter.createInvoice(INPUT)).invoiceUrl).toBe("http://localhost:9999/inv_1");
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

  // Measured before the fix: a 200 with an empty body returned
  // {"invoiceId":"undefined","invoiceUrl":"undefined"} and reported success.
  // The buyer would be redirected to the URL "undefined", and Task 7 would
  // store "undefined" as the gateway reference for EVERY such invoice, so they
  // would all collide. This adapter is explicitly unverified against the live
  // API, so an unrecognised shape must fail loudly.
  it("throws on a 200 whose body carries no invoice", async () => {
    const { fetchFn } = captureFetch({});
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    const error = (await adapter.createInvoice(INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("createInvoice");
    expect(error.message).toContain('"id"');
  });

  it("throws on a 200 with the right keys but non-string values", async () => {
    const { fetchFn } = captureFetch({ id: 12345, invoice_url: { href: "https://x/inv_1" } });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    const error = (await adapter.createInvoice(INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('"id"');
  });

  it("throws when the id is present but the invoice url is missing", async () => {
    const { fetchFn } = captureFetch({ id: "inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    const error = (await adapter.createInvoice(INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('"invoice_url"');
  });

  it("rejects an empty string as an invoice id", async () => {
    const { fetchFn } = captureFetch({ id: "", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await expect(adapter.createInvoice(INPUT)).rejects.toThrow(/"id"/);
  });

  it("does not leak the secret key when the response shape is wrong", async () => {
    const { fetchFn } = captureFetch({});
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test_SUPERSECRET", splitRuleId: "splitrule_1", fetchFn,
    });

    const error = (await adapter.createInvoice(INPUT).catch((e) => e)) as Error;
    expect(error.message).not.toContain("sk_test_SUPERSECRET");
  });

  // Bare fetch has no timeout: a hung Xendit response would hold a checkout
  // request open indefinitely once StartCheckout (Task 6) calls this.
  it("gives up on a hung Xendit response instead of hanging the checkout", async () => {
    const { calls, fetchFn } = captureFetch({ id: "inv_1", invoice_url: "https://x/inv_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createInvoice(INPUT);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("XenditPaymentAdapter.createPaymentAccount", () => {
  const ACCOUNT_INPUT = { creatorId: "c1", email: "a@b.co", name: "Budi" };

  it("returns the sub-account id", async () => {
    const { fetchFn } = captureFetch({ id: "acct_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    expect(await adapter.createPaymentAccount(ACCOUNT_INPUT)).toEqual({ accountId: "acct_1" });
  });

  // Before the fix this returned { accountId: "undefined" }, which
  // CreatePaymentAccount would have written into creator.xendit_account_id —
  // and then 409'd on forever, with no reset path.
  it("throws on a 200 whose body carries no account id", async () => {
    const { fetchFn } = captureFetch({});
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    const error = (await adapter.createPaymentAccount(ACCOUNT_INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("createPaymentAccount");
    expect(error.message).toContain('"id"');
  });

  it("carries an abort signal", async () => {
    const { calls, fetchFn } = captureFetch({ id: "acct_1" });
    const adapter = new XenditPaymentAdapter({
      secretKey: "sk_test", splitRuleId: "splitrule_1", fetchFn,
    });

    await adapter.createPaymentAccount(ACCOUNT_INPUT);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
