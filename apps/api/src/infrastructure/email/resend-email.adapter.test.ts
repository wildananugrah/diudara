import { describe, expect, it } from "bun:test";
import { ResendEmailAdapter } from "./resend-email.adapter";

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
  to: "budi@example.com",
  subject: "Pulihkan kata sandi Anda",
  body: "Klik tautan ini untuk memulihkan kata sandi Anda: http://localhost:5173/reset/abc123",
};

describe("ResendEmailAdapter.send", () => {
  it("POSTs to Resend's endpoint with the API key in the Authorization header", async () => {
    const { calls, fetchFn } = captureFetch({ id: "email_1" });
    const adapter = new ResendEmailAdapter({
      apiKey: "re_test_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    await adapter.send(INPUT);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
  });

  it("sends the right JSON body: from, to, subject and plain-text body", async () => {
    const { calls, fetchFn } = captureFetch({ id: "email_1" });
    const adapter = new ResendEmailAdapter({
      apiKey: "re_test_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    await adapter.send(INPUT);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      from: "DIUDARA <no-reply@diudara.example>",
      to: INPUT.to,
      subject: INPUT.subject,
      text: INPUT.body,
    });
  });

  it("uses the injected fetchFn rather than the global fetch", async () => {
    let called = false;
    const fetchFn = async (_url: string, _init: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    };
    const adapter = new ResendEmailAdapter({
      apiKey: "re_test_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    await adapter.send(INPUT);

    expect(called).toBe(true);
  });

  it("throws on a non-2xx response without leaking the API key", async () => {
    const { fetchFn } = captureFetch({ message: "invalid from address" }, 422);
    const adapter = new ResendEmailAdapter({
      apiKey: "re_SUPERSECRET_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    const error = (await adapter.send(INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("re_SUPERSECRET_key");
  });

  it("throws on a non-2xx response with a message that does not echo the response body", async () => {
    const { fetchFn } = captureFetch({ message: "some resend-specific detail" }, 400);
    const adapter = new ResendEmailAdapter({
      apiKey: "re_test_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    const error = (await adapter.send(INPUT).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("some resend-specific detail");
    expect(error.message).toContain("400");
  });

  it("resolves on a 2xx response", async () => {
    const { fetchFn } = captureFetch({ id: "email_1" }, 200);
    const adapter = new ResendEmailAdapter({
      apiKey: "re_test_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    await expect(adapter.send(INPUT)).resolves.toBeUndefined();
  });

  it("gives up on a hung Resend response instead of hanging the caller", async () => {
    const { calls, fetchFn } = captureFetch({ id: "email_1" });
    const adapter = new ResendEmailAdapter({
      apiKey: "re_test_key", from: "DIUDARA <no-reply@diudara.example>", fetchFn,
    });

    await adapter.send(INPUT);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
