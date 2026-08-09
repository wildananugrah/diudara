import { describe, expect, it } from "bun:test";
import { TelegramBotAdapter, TELEGRAM_DEFAULT_INVITE_TTL_SECONDS } from "./telegram-bot.adapter";
import { ProviderCallError, UnsupportedOperationError } from "../../application/errors";

/**
 * The token is INSIDE the request URL for every Bot API call
 * (`/bot<token>/<method>`), so it is the one secret in this repository that a
 * naive "include the url in the error" would publish. Every failure-path test
 * below asserts against this exact value.
 */
const BOT_TOKEN = "123456:AA_SUPERSECRET_BOT_TOKEN";

type Captured = { url: string; init: RequestInit };

/** The same response for every call — enough for the happy paths. */
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

/**
 * Responds per Bot API method, so a test can fail ONE call of a multi-call
 * operation (grantAccess issues unbanChatMember then createChatInviteLink).
 */
function captureRoutedFetch(routes: Record<string, { body: unknown; status?: number }>) {
  const calls: Captured[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const match = Object.keys(routes).find((method) => url.includes(`/${method}`));
    const route = match ? routes[match] : { body: { ok: true, result: true } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

const INVITE_OK = { ok: true, result: { invite_link: "https://t.me/+AbCdEf123" } };

function adapter(fetchFn: (url: string, init: RequestInit) => Promise<Response>, extra = {}) {
  return new TelegramBotAdapter({ botToken: BOT_TOKEN, fetchFn, ...extra });
}

function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

const GRANT = { externalGroupId: "-1001234567890", memberWhatsappNumber: "+6281234567890" };
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("TelegramBotAdapter capabilities", () => {
  it("reports that it CAN gate access", () => {
    const { fetchFn } = captureFetch(INVITE_OK);
    const a = adapter(fetchFn);
    expect(a.platform).toBe("telegram");
    expect(a.capabilities().canGateAccess).toBe(true);
  });
});

describe("TelegramBotAdapter.grantAccess", () => {
  it("calls createChatInviteLink for the channel's group", async () => {
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await adapter(fetchFn).grantAccess(GRANT);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/bot${BOT_TOKEN}/createChatInviteLink`);
    expect(calls[0].init.method).toBe("POST");
    expect(bodyOf(calls[0]).chat_id).toBe("-1001234567890");
  });

  /**
   * `member_limit: 1` is what makes the link single-use. Without it ONE paying
   * member's link admits everyone they forward it to — the product charges for
   * access it would then be giving away.
   */
  it("sends member_limit: 1, so the link admits exactly one member", async () => {
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await adapter(fetchFn).grantAccess(GRANT);

    expect(bodyOf(calls[0]).member_limit).toBe(1);
  });

  /**
   * The other half, and independently necessary: `member_limit: 1` alone means a
   * leaked link that was never USED works forever. `expire_date` bounds that.
   */
  it("sends an expire_date in the FUTURE, so an unused leaked link dies", async () => {
    const before = nowSeconds();
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await adapter(fetchFn).grantAccess(GRANT);

    const expireDate = bodyOf(calls[0]).expire_date;
    expect(typeof expireDate).toBe("number");
    expect(Number.isInteger(expireDate)).toBe(true);
    expect(expireDate as number).toBeGreaterThan(before);
    // Telegram takes UNIX SECONDS. A milliseconds value would be a date in the
    // year 57000 — i.e. no expiry at all, silently.
    expect(expireDate as number).toBeLessThanOrEqual(
      before + TELEGRAM_DEFAULT_INVITE_TTL_SECONDS + 5
    );
  });

  it("honours a configured inviteTtlSeconds", async () => {
    const before = nowSeconds();
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await adapter(fetchFn, { inviteTtlSeconds: 600 }).grantAccess(GRANT);

    const expireDate = bodyOf(calls[0]).expire_date as number;
    expect(expireDate).toBeGreaterThanOrEqual(before + 600);
    expect(expireDate).toBeLessThanOrEqual(before + 605);
  });

  it("returns the invite link the API issued", async () => {
    const { fetchFn } = captureFetch(INVITE_OK);

    expect(await adapter(fetchFn).grantAccess(GRANT)).toEqual({
      inviteLink: "https://t.me/+AbCdEf123",
    });
  });

  it("carries an abort signal, so a hung Telegram response cannot stall the worker", async () => {
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await adapter(fetchFn).grantAccess(GRANT);

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * The easy-to-miss Telegram rule (plan, "Verified facts"): a BANNED user cannot
   * join via any invite link, so a churned member who re-pays gets a link that
   * silently does not work. `unbanChatMember` must run FIRST — and it needs the
   * member's Telegram user id, which only exists for someone we granted before,
   * hence `previousExternalMemberId`.
   */
  it("unbans a previously-revoked member BEFORE issuing the new link", async () => {
    const { calls, fetchFn } = captureRoutedFetch({ createChatInviteLink: { body: INVITE_OK } });

    await adapter(fetchFn).grantAccess({ ...GRANT, previousExternalMemberId: "987654321" });

    expect(calls).toHaveLength(2);
    // ORDER is the assertion. Unbanning after the link is issued would leave the
    // link unusable for as long as the ban stands.
    expect(calls[0].url).toContain("/unbanChatMember");
    expect(calls[1].url).toContain("/createChatInviteLink");
    const unban = bodyOf(calls[0]);
    expect(unban.chat_id).toBe("-1001234567890");
    expect(unban.user_id).toBe(987654321);
  });

  /**
   * Telegram's default for `unbanChatMember` is "after this call the user is not
   * a chat member" — so calling it on someone who is CURRENTLY in the group
   * removes them. `only_if_banned: true` makes it a no-op unless they are
   * actually banned, which is what makes it safe to call on every re-grant.
   */
  it("sends only_if_banned so an unban never kicks a current member", async () => {
    const { calls, fetchFn } = captureRoutedFetch({ createChatInviteLink: { body: INVITE_OK } });

    await adapter(fetchFn).grantAccess({ ...GRANT, previousExternalMemberId: "987654321" });

    expect(bodyOf(calls[0]).only_if_banned).toBe(true);
  });

  it("does not call unbanChatMember for a first-time grant, when no user id exists yet", async () => {
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await adapter(fetchFn).grantAccess(GRANT);

    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/unbanChatMember"))).toBe(false);
  });

  it("THROWS when the unban fails, rather than issuing a link that cannot be used", async () => {
    const { calls, fetchFn } = captureRoutedFetch({
      unbanChatMember: { body: { ok: false, error_code: 400, description: "not enough rights" } },
      createChatInviteLink: { body: INVITE_OK },
    });

    const error = (await adapter(fetchFn)
      .grantAccess({ ...GRANT, previousExternalMemberId: "987654321" })
      .catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("unbanChatMember");
    expect(error.message).not.toContain(BOT_TOKEN);
    // And no link was created, so nothing was returned that looks like success.
    expect(calls.some((c) => c.url.includes("/createChatInviteLink"))).toBe(false);
  });

  it("refuses a previous member id that is not a Telegram user id, without calling out", async () => {
    // Telegram user ids are integers. A non-numeric value here means our own
    // record is wrong; sending it would produce a confusing provider error.
    for (const bad of ["not-a-number", "", "12.5", "1e3", "+6281234567890"]) {
      const { calls, fetchFn } = captureFetch(INVITE_OK);
      const error = (await adapter(fetchFn)
        .grantAccess({ ...GRANT, previousExternalMemberId: bad })
        .catch((e) => e)) as Error;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("user id");
      expect(calls).toHaveLength(0);
    }
  });
});

/**
 * The method that makes the credential-lifecycle invariant enforceable: without a
 * way to UNMINT a link, a `recordGrant` that fails after a successful mint can only
 * leak a live credential nobody holds. See GrantChannelAccess.
 */
describe("TelegramBotAdapter.revokeInviteLink", () => {
  it("calls revokeChatInviteLink with the link, so a lost credential can be killed", async () => {
    const { calls, fetchFn } = captureFetch({ ok: true, result: { invite_link: "x" } });

    await adapter(fetchFn).revokeInviteLink({
      externalGroupId: "-1001234567890",
      inviteLink: "https://t.me/+lost-credential",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/bot${BOT_TOKEN}/revokeChatInviteLink`);
    // Telegram's method takes the link ITSELF — there is no Bot API call that
    // enumerates a bot's links, which is exactly why a link whose value we lost is
    // unkillable and why GrantChannelAccess refuses to mint a replacement.
    expect(bodyOf(calls[0])).toMatchObject({
      chat_id: "-1001234567890",
      invite_link: "https://t.me/+lost-credential",
    });
  });

  it("throws when Telegram refuses, so the caller keeps the mint marker set", async () => {
    // The caller treats a throw here as "an orphan is live and unkillable", which is
    // what stops it minting a replacement. A silent success would clear the marker.
    const { fetchFn } = captureFetch({ ok: false, description: "invite link not found" });

    const error = (await adapter(fetchFn)
      .revokeInviteLink({ externalGroupId: "-100", inviteLink: "https://t.me/+x" })
      .catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("revokeChatInviteLink");
    expect(error.message).not.toContain(BOT_TOKEN);
    // Not even the link it was asked about: it may still be a working credential.
    expect(error.message).not.toContain("t.me/+x");
  });

  it("carries an abort signal", async () => {
    const { calls, fetchFn } = captureFetch({ ok: true, result: true });

    await adapter(fetchFn).revokeInviteLink({
      externalGroupId: "-100",
      inviteLink: "https://t.me/+x",
    });

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("TelegramBotAdapter.revokeAccess", () => {
  it("bans the member, which also stops them rejoining by any old link", async () => {
    const { calls, fetchFn } = captureFetch({ ok: true, result: true });

    await adapter(fetchFn).revokeAccess({
      externalGroupId: "-1001234567890",
      externalMemberId: "987654321",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/bot${BOT_TOKEN}/banChatMember`);
    expect(bodyOf(calls[0])).toMatchObject({ chat_id: "-1001234567890", user_id: 987654321 });
  });

  it("throws when Telegram refuses the ban, so a revoke never silently no-ops", async () => {
    const { fetchFn } = captureFetch({
      ok: false,
      error_code: 400,
      description: "user not found",
    });

    const error = (await adapter(fetchFn)
      .revokeAccess({ externalGroupId: "-100", externalMemberId: "1" })
      .catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("banChatMember");
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it("carries an abort signal", async () => {
    const { calls, fetchFn } = captureFetch({ ok: true, result: true });

    await adapter(fetchFn).revokeAccess({ externalGroupId: "-100", externalMemberId: "1" });

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("TelegramBotAdapter.notify", () => {
  it("throws rather than pretending to send a WhatsApp message", async () => {
    // The port's notify targets a WhatsApp NUMBER. A Telegram bot cannot reach
    // one, and it has no chat id for the member either. Returning quietly would
    // make a caller believe the member was told.
    const { calls, fetchFn } = captureFetch(INVITE_OK);

    await expect(
      adapter(fetchFn).notify({ toWhatsappNumber: "+6281234567890", message: "halo" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(calls).toHaveLength(0);
  });
});

describe("TelegramBotAdapter error handling", () => {
  it("throws on a non-2xx response without leaking the bot token", async () => {
    const { fetchFn } = captureFetch({ ok: false, description: "Unauthorized" }, 401);

    const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("401");
    // The token is in the URL of every Bot API call, so an error that echoed the
    // request would publish it to whatever reads the worker's logs.
    expect(error.message).not.toContain(BOT_TOKEN);
    expect(error.message).not.toContain("/bot");
  });

  it("throws on a 200 whose body says ok: false", async () => {
    // Telegram answers some failures with HTTP 200 and `ok: false`. Treating that
    // as success is how a bogus link reaches a paying member.
    const { fetchFn } = captureFetch({
      ok: false,
      error_code: 400,
      description: "CHAT_ADMIN_REQUIRED",
    });

    const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("createChatInviteLink");
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  /**
   * Phase 3's exact bug: `String(body.id)` on an unrecognised 200 returned the
   * literal string "undefined" and reported SUCCESS. Here that would be an
   * invite link of "undefined" delivered to someone who paid.
   */
  it("throws on a 200 with no invite_link, instead of returning \"undefined\"", async () => {
    const { fetchFn } = captureFetch({ ok: true, result: {} });

    const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('"invite_link"');
  });

  it("throws on a 200 with no result object at all", async () => {
    for (const body of [{ ok: true }, { ok: true, result: null }, { ok: true, result: "x" }, {}]) {
      const { fetchFn } = captureFetch(body);
      const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(BOT_TOKEN);
    }
  });

  it("throws on an invite_link that is not a non-empty string", async () => {
    for (const invite_link of [12345, "", null, { href: "https://t.me/+x" }]) {
      const { fetchFn } = captureFetch({ ok: true, result: { invite_link } });
      const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('"invite_link"');
    }
  });

  it("refuses an invite_link that is not an http(s) URL", async () => {
    // It is handed to a member to open. A `javascript:` value from an
    // unrecognised response body has no business being forwarded.
    const { fetchFn } = captureFetch({
      ok: true,
      result: { invite_link: "javascript:alert(1)" },
    });

    const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("http");
  });

  it("throws on a body that is not JSON at all, without leaking the token", async () => {
    const calls: Captured[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  /**
   * WHETHER A RESPONSE WAS RECEIVED, surfaced as a typed field.
   *
   * The adapter is the only thing that knows, and `GrantChannelAccess` cannot fix a
   * transiently-failed grant without being told: it takes the mint window BEFORE
   * calling `grantAccess`, and the marker it writes forbids minting for that (member,
   * channel) forever unless something releases it. `"rejected"` means the provider
   * answered and therefore minted nothing, so the window may be released and the retry
   * mints cleanly. `"indeterminate"` means a link may be live with nobody holding it,
   * so the grant must fail closed.
   *
   * Measured with no distinction: one transient Telegram failure followed by a healthy
   * provider left the pair permanently ungrantable, silently.
   *
   * The classification is asserted on the FIELD, never on the message text. A caller
   * that had to grep an error string for "timeout" would be deciding a paying member's
   * access from a sentence that varies by runtime, proxy and Bun version.
   */
  it("classifies a non-2xx as `rejected` — Telegram answered, so nothing was minted", async () => {
    for (const status of [400, 401, 429, 500, 502, 503]) {
      const { fetchFn } = captureFetch({ ok: false, description: "nope" }, status);

      const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

      expect(error).toBeInstanceOf(ProviderCallError);
      expect((error as ProviderCallError).outcome).toBe("rejected");
    }
  });

  it("classifies a 200 with ok: false as `rejected`", async () => {
    const { fetchFn } = captureFetch({ ok: false, error_code: 400, description: "CHAT_ADMIN_REQUIRED" });

    const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).outcome).toBe("rejected");
  });

  it("classifies a failed unban leg as `rejected`, so a re-grant is retryable", async () => {
    // The unban runs BEFORE createChatInviteLink, so a rejection there means the mint
    // never happened at all. Reading it as ambiguous would strand a churned member who
    // re-paid — the exact population this leg exists to serve.
    const { fetchFn } = captureRoutedFetch({
      unbanChatMember: { body: { ok: false, error_code: 400, description: "not enough rights" } },
    });

    const error = (await adapter(fetchFn)
      .grantAccess({ ...GRANT, previousExternalMemberId: "987654321" })
      .catch((e) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).outcome).toBe("rejected");
  });

  it("classifies a locally refused member id as `rejected` — no request was made", async () => {
    const { calls, fetchFn } = captureFetch({ ok: true, result: { invite_link: "https://t.me/+x" } });

    const error = (await adapter(fetchFn)
      .grantAccess({ ...GRANT, previousExternalMemberId: "+6281234567890" })
      .catch((e) => e)) as Error;

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).outcome).toBe("rejected");
  });

  it("classifies a request that never completed as `indeterminate`", async () => {
    // What the 15s AbortSignal produces, and what a reset connection produces. The
    // request may have reached Telegram and been acted on: a link could be live with
    // nobody holding its value, which is the one state that must fail closed.
    for (const thrown of [
      Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
      Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
      new TypeError("fetch failed"),
    ]) {
      const fetchFn = async () => {
        throw thrown;
      };

      const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;

      expect(error).toBeInstanceOf(ProviderCallError);
      expect((error as ProviderCallError).outcome).toBe("indeterminate");
      // The original is kept for diagnosis; the message interpolates nothing, because
      // the URL that failed carries the bot token.
      expect(error.cause).toBe(thrown);
      expect(error.message).not.toContain(BOT_TOKEN);
    }
  });

  it("classifies an unreadable SUCCESS as `indeterminate` — a link probably exists", async () => {
    // `ok: true` with a shape we cannot read is the worst case: Telegram made a link
    // and we do not hold its value, so it can never be revoked. Same for a 200 that is
    // not JSON at all, where we cannot tell whether the method ran.
    const bodies: { body: unknown; json?: boolean }[] = [
      { body: { ok: true, result: {} } },
      { body: { ok: true, result: { invite_link: "" } } },
      { body: { ok: true, result: { invite_link: "javascript:alert(1)" } } },
      { body: { ok: true } },
    ];
    for (const { body } of bodies) {
      const { fetchFn } = captureFetch(body);
      const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(ProviderCallError);
      expect((error as ProviderCallError).outcome).toBe("indeterminate");
    }

    const htmlFetch = async () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    const htmlError = (await adapter(htmlFetch).grantAccess(GRANT).catch((e) => e)) as Error;
    expect(htmlError).toBeInstanceOf(ProviderCallError);
    expect((htmlError as ProviderCallError).outcome).toBe("indeterminate");
  });

  it("never puts the token in an error, on any failure path", async () => {
    const failures: { body: unknown; status?: number }[] = [
      { body: { ok: false, description: "Unauthorized" }, status: 401 },
      { body: {}, status: 500 },
      { body: { ok: true, result: {} } },
      { body: { ok: false, error_code: 400, description: BOT_TOKEN } },
    ];

    for (const failure of failures) {
      const { fetchFn } = captureFetch(failure.body, failure.status ?? 200);
      const error = (await adapter(fetchFn).grantAccess(GRANT).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      // The last case is deliberately adversarial: even a provider DESCRIPTION
      // that happens to contain the token must not be echoed, which is why no
      // response body is ever interpolated into a message.
      expect(error.message).not.toContain(BOT_TOKEN);
    }
  });
});
