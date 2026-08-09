import { describe, expect, it } from "bun:test";
import { FonnteWhatsAppAdapter } from "./fonnte-whatsapp.adapter";
import { UnsupportedOperationError } from "../../application/errors";

const API_TOKEN = "FONNTE_SUPERSECRET_TOKEN";

type Captured = { url: string; init: RequestInit };

function captureFetch(response: unknown, status = 200) {
  const calls: Captured[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

const SEND_OK = { detail: "success! message in queue", status: true, id: ["1"] };

function adapter(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
  return new FonnteWhatsAppAdapter({ apiToken: API_TOKEN, fetchFn });
}

/** Fonnte's documented request format is form-encoded. */
function fieldsOf(call: Captured): URLSearchParams {
  return new URLSearchParams(call.init.body as string);
}

const NOTIFY = { toWhatsappNumber: "+6281234567890", message: "Halo! Ini link grup kamu." };

describe("FonnteWhatsAppAdapter capabilities", () => {
  /**
   * The whole point of the capability boundary. Meta's official Groups API has no
   * POST /participants and caps groups at 8 participants, and an unofficial
   * gateway would drive — and risk — the CREATOR's own WhatsApp account. So this
   * provider notifies and nothing else, and it says so in the type system rather
   * than in a comment.
   */
  it("reports that it CANNOT gate access", () => {
    const { fetchFn } = captureFetch(SEND_OK);
    const a = adapter(fetchFn);
    expect(a.platform).toBe("whatsapp");
    expect(a.capabilities().canGateAccess).toBe(false);
  });
});

describe("FonnteWhatsAppAdapter gating is unsupported", () => {
  it("THROWS on grantAccess instead of silently no-opping", async () => {
    // A silent success is the worst failure mode in this phase: a paying member
    // appears granted and is not.
    const { calls, fetchFn } = captureFetch(SEND_OK);

    await expect(
      adapter(fetchFn).grantAccess({
        externalGroupId: "group-1",
        memberWhatsappNumber: "+6281234567890",
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(calls).toHaveLength(0);
  });

  it("THROWS on revokeAccess too", async () => {
    const { calls, fetchFn } = captureFetch(SEND_OK);

    await expect(
      adapter(fetchFn).revokeAccess({ externalGroupId: "group-1", externalMemberId: "m1" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(calls).toHaveLength(0);
  });

  it("explains WHY, so nobody adds WhatsApp group management by mistake", async () => {
    const { fetchFn } = captureFetch(SEND_OK);

    const error = (await adapter(fetchFn)
      .grantAccess({ externalGroupId: "g", memberWhatsappNumber: "+62" })
      .catch((e) => e)) as Error;

    expect(error.message).toContain("whatsapp");
    expect(error.message.toLowerCase()).toContain("notification");
  });
});

describe("FonnteWhatsAppAdapter.notify", () => {
  it("posts the message to Fonnte's send endpoint with the token in the header", async () => {
    const { calls, fetchFn } = captureFetch(SEND_OK);

    await adapter(fetchFn).notify(NOTIFY);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.fonnte.com/send");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(API_TOKEN);
    const fields = fieldsOf(calls[0]);
    expect(fields.get("message")).toBe(NOTIFY.message);
  });

  it("never puts the recipient's number in the URL", async () => {
    // The URL is what ends up in HTTP client logs and proxy access logs; the
    // member's phone number is PII.
    const { calls, fetchFn } = captureFetch(SEND_OK);

    await adapter(fetchFn).notify(NOTIFY);

    expect(calls[0].url).not.toContain("6281234567890");
  });

  it("sends the target in the digits-only form Fonnte's documentation uses", async () => {
    // We store E.164 (`+6281234567890`); every Fonnte example is `6281234567890`.
    const { calls, fetchFn } = captureFetch(SEND_OK);

    await adapter(fetchFn).notify(NOTIFY);

    expect(fieldsOf(calls[0]).get("target")).toBe("6281234567890");
  });

  it("carries an abort signal", async () => {
    const { calls, fetchFn } = captureFetch(SEND_OK);

    await adapter(fetchFn).notify(NOTIFY);

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a non-2xx response without leaking the API token", async () => {
    const { fetchFn } = captureFetch({ detail: "token invalid" }, 401);

    const error = (await adapter(fetchFn).notify(NOTIFY).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("401");
    expect(error.message).not.toContain(API_TOKEN);
  });

  it("throws on a 200 that reports status: false", async () => {
    // Fonnte answers a rejected send with HTTP 200 and `status: false`. Treating
    // that as sent means the member is never told, and nothing notices.
    const { fetchFn } = captureFetch({ detail: "invalid target", status: false });

    const error = (await adapter(fetchFn).notify(NOTIFY).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("notify");
    expect(error.message).not.toContain(API_TOKEN);
  });

  it("throws on a 200 whose body has no recognisable status", async () => {
    for (const body of [{}, { detail: "ok" }, { status: "true" }, { status: 1 }, []]) {
      const { fetchFn } = captureFetch(body);
      const error = (await adapter(fetchFn).notify(NOTIFY).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('"status"');
      expect(error.message).not.toContain(API_TOKEN);
    }
  });

  it("accepts the array-shaped status Fonnte returns for a batch send", async () => {
    const { fetchFn } = captureFetch({ detail: "success", status: [true] });
    await adapter(fetchFn).notify(NOTIFY);
  });

  it("rejects an array status containing a failure", async () => {
    const { fetchFn } = captureFetch({ detail: "partial", status: [true, false] });

    const error = (await adapter(fetchFn).notify(NOTIFY).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('"status"');
  });

  it("throws on a body that is not JSON, without leaking the token", async () => {
    const fetchFn = async () =>
      new Response("<html>502</html>", { status: 200, headers: { "Content-Type": "text/html" } });

    const error = (await adapter(fetchFn).notify(NOTIFY).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(API_TOKEN);
  });

  it("never puts the token in an error, even when the provider echoes it back", async () => {
    const { fetchFn } = captureFetch({ status: false, detail: `bad token ${API_TOKEN}` });

    const error = (await adapter(fetchFn).notify(NOTIFY).catch((e) => e)) as Error;

    expect(error.message).not.toContain(API_TOKEN);
  });
});
