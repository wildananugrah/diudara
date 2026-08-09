import { ProviderCallError, UnsupportedOperationError } from "../../application/errors";
import type {
  GrantAccessInput,
  MessagingCapabilities,
  MessagingProviderPort,
  NotifyInput,
  RevokeAccessInput,
  RevokeInviteLinkInput,
} from "../../application/ports/messaging-provider.port";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://api.telegram.org";

/**
 * Bare `fetch` has no timeout. This adapter is called by the outbox worker, so a
 * hung Telegram response would hold a claimed row open indefinitely — the row is
 * already claimed, so nothing else would retry it. 15s is generous for a Bot API
 * call, and a timeout surfaces as an error we control, which the worker then
 * retries with backoff.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How long an issued invite link stays usable.
 *
 * `member_limit: 1` and `expire_date` are independently necessary. Without the
 * limit, one paying member's link admits everyone they forward it to. Without the
 * expiry, a link that was leaked but never USED works forever — the limit never
 * fires because nobody consumed it.
 *
 * 24 hours: long enough for a member who paid on their phone at midnight to
 * notice the WhatsApp message and tap the link the next morning, short enough
 * that a link found in a screenshot months later is dead. A re-grant issues a
 * fresh link, so an expired one is recoverable.
 */
export const TELEGRAM_DEFAULT_INVITE_TTL_SECONDS = 24 * 60 * 60;

/** Telegram user ids are integers; ours arrive as strings from the database. */
const TELEGRAM_USER_ID = /^[0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * !!! UNVERIFIED AGAINST THE LIVE TELEGRAM BOT API !!!
 *
 * Written from Telegram's published Bot API documentation with no bot token, so
 * the request shapes and the error handling are ASSUMPTIONS. The tests beside
 * this file prove the PORT CONTRACT and the gating parameters that make an
 * invite single-use — they do NOT prove this works against Telegram. Unlike
 * Xendit, a token is free and instant from @BotFather, so exercise this against a
 * real bot and a real test group before a paying member depends on it, then
 * delete this warning.
 *
 * Three things here are load-bearing and each is pinned by a test:
 *
 *   member_limit: 1   -> the link admits exactly one member
 *   expire_date       -> an unused leaked link dies
 *   unbanChatMember   -> a previously-revoked member can rejoin at all
 *
 * SECRET HANDLING: the bot token is part of the request PATH
 * (`<base>/bot<token>/<method>`), which makes it the easiest secret in this
 * repository to leak. No error message in this file interpolates a URL, a
 * request, or a response body — only the method name and the HTTP status. The
 * response body is excluded even though Telegram's `description` field is useful,
 * because a provider that echoes our own token back (or an operator who
 * misconfigures a proxy) would otherwise put it in the worker's logs.
 */
export class TelegramBotAdapter implements MessagingProviderPort {
  readonly platform = "telegram";

  private readonly botToken: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly inviteTtlSeconds: number;

  constructor(config: {
    botToken: string;
    baseUrl?: string;
    fetchFn?: FetchFn;
    inviteTtlSeconds?: number;
  }) {
    this.botToken = config.botToken;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
    this.inviteTtlSeconds = config.inviteTtlSeconds ?? TELEGRAM_DEFAULT_INVITE_TTL_SECONDS;
  }

  capabilities(): MessagingCapabilities {
    return { canGateAccess: true };
  }

  /**
   * Issues a single-use, expiring invite link.
   *
   * The unban comes FIRST, and only when we have a user id from a previous grant.
   * `banChatMember` — what `revokeAccess` uses — also prevents rejoining via any
   * invite link, so for a churned member who re-pays, creating the link without
   * unbanning first produces a link that looks fine and silently does not work.
   * That ordering belongs HERE rather than in a use-case: it is a Telegram rule,
   * the use-case has no reason to know Telegram has bans, and the alternative
   * (deriving "is banned" from `channel_membership.status`) would be wrong the
   * moment a creator bans someone by hand in the Telegram client.
   *
   * `only_if_banned: true` is what makes calling it on every re-grant safe.
   * Telegram's default guarantees the user is NOT a chat member afterwards, so an
   * unconditional unban would remove someone who is currently in the group.
   */
  async grantAccess(input: GrantAccessInput): Promise<{ inviteLink: string }> {
    if (input.previousExternalMemberId !== undefined) {
      await this.call("unbanChatMember", {
        chat_id: input.externalGroupId,
        user_id: this.requireTelegramUserId(input.previousExternalMemberId),
        only_if_banned: true,
      });
    }

    const result = await this.call("createChatInviteLink", {
      chat_id: input.externalGroupId,
      // Both, always. See TELEGRAM_DEFAULT_INVITE_TTL_SECONDS.
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + this.inviteTtlSeconds,
    });

    return { inviteLink: this.requireInviteLink(result) };
  }

  /**
   * `revokeChatInviteLink` — the counterpart to `createChatInviteLink`, and what
   * makes the credential-lifecycle invariant enforceable (see the port docstring).
   *
   * Telegram's method takes the link itself, which is why the caller has to still
   * HOLD it: there is no Bot API method that enumerates the links a bot created, so
   * a link whose value we lost cannot be revoked by any means. That asymmetry is the
   * whole reason `GrantChannelAccess` refuses to mint a replacement once a mint has
   * been recorded as started and not finished — a second link would be a second
   * credential with the first still live and unrecorded.
   *
   * A revoked link is not deleted at Telegram; it stops admitting anyone, which is
   * the property that matters. `member_limit: 1` and the 24h `expire_date` narrow
   * the exposure but do not close it: an UNUSED link is live for the whole window
   * and admits whoever it was forwarded to.
   */
  async revokeInviteLink(input: RevokeInviteLinkInput): Promise<void> {
    await this.call("revokeChatInviteLink", {
      chat_id: input.externalGroupId,
      invite_link: input.inviteLink,
    });
  }

  /**
   * `banChatMember`, not `kickChatMember`/leave: a plain removal lets the member
   * walk back in with any invite link they still hold, including the one they were
   * originally sent.
   */
  async revokeAccess(input: RevokeAccessInput): Promise<void> {
    await this.call("banChatMember", {
      chat_id: input.externalGroupId,
      user_id: this.requireTelegramUserId(input.externalMemberId),
    });
  }

  /**
   * `NotifyInput` addresses a WhatsApp NUMBER. A Telegram bot cannot reach one,
   * and it has no Telegram chat id for the member either — an invite link is
   * exactly what you issue when you do NOT know who the member is on Telegram.
   *
   * So this throws rather than returning quietly: a caller that believed the
   * member had been told would leave someone who paid waiting for a message that
   * was never sent. Member notification is the WhatsApp provider's job.
   */
  async notify(_input: NotifyInput): Promise<void> {
    throw new UnsupportedOperationError(
      "telegram cannot send a WhatsApp notification: this provider gates group access " +
        "only, and has no Telegram chat id for a member it has merely invited. Notify " +
        "through the WhatsApp provider instead."
    );
  }

  /**
   * One Bot API call, with every failure turned into a CLASSIFIED throw.
   *
   * Telegram reports plenty of failures as HTTP 200 with `ok: false`, so the
   * status check alone is not enough — and returning a "successful" result from an
   * unrecognised body is how `String(body.id)` produced the literal invite link
   * "undefined" in Phase 3.
   *
   * EVERY THROW CARRIES A `ProviderCallOutcome`, and the line between them is whether
   * a response came back (see the port's `grantAccess` docstring for why the caller
   * needs it — a `"rejected"` mint failure reopens the mint window, an
   * `"indeterminate"` one leaves a paying member needing a manual reissue):
   *
   *   fetch itself threw    -> indeterminate  the request may have reached Telegram and
   *                                           been acted on; an AbortSignal timeout at
   *                                           15s lands here, and so does a reset
   *                                           connection. WE DO NOT KNOW.
   *   non-2xx status        -> rejected       Telegram answered and refused. A 429 or a
   *                                           5xx did not create anything.
   *   200, body not JSON    -> indeterminate  a proxy or error page. The Bot API may or
   *                                           may not have run the method.
   *   200, "ok": false      -> rejected       Telegram answered that the method failed.
   *   200, "ok": true       -> success, or `requireInviteLink` throws indeterminate:
   *                                           a link probably EXISTS and we cannot read
   *                                           its value, which is the worst case and
   *                                           must fail closed.
   *
   * The 5xx-is-rejected call is worth stating plainly: a gateway 502 in front of
   * Telegram could in principle sit on a request that succeeded. But Telegram's own
   * documented failures (429 rate limits, 5xx) come back as a status with `ok: false`
   * before the method runs, and treating them as ambiguous is what made a single
   * transient blip permanently poison a grant. The residual risk is bounded by
   * `member_limit: 1` and the 24h expiry; the alternative was measured to strand
   * paying members.
   */
  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // No response at all: a timeout, an abort, a DNS or TLS failure, a reset. The
      // request may have been delivered and acted on, so this is the ambiguous case.
      // `cause` is kept for diagnosis; nothing is interpolated, since the URL that
      // failed carries the bot token.
      throw new ProviderCallError(
        `telegram ${method} never completed: no HTTP response was received (a timeout, ` +
          "abort or connection failure). Whether Telegram acted on the request is UNKNOWN.",
        "indeterminate",
        { cause: err }
      );
    }

    if (!response.ok) {
      throw new ProviderCallError(
        `telegram ${method} failed with status ${response.status} ` +
          "(no request or response detail is included on purpose: the bot token is part " +
          "of every Bot API request path)",
        // Telegram answered. It did not do the thing.
        "rejected"
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ProviderCallError(
        `telegram ${method} returned a 200 whose body is not JSON — most likely a proxy ` +
          "or error page rather than the Bot API",
        // A 200 we cannot read is not evidence that nothing happened.
        "indeterminate"
      );
    }

    if (!isRecord(parsed) || parsed.ok !== true) {
      throw new ProviderCallError(
        `telegram ${method} failed: the response does not carry "ok": true. The provider ` +
          "description is deliberately not repeated here — see the SECRET HANDLING note in " +
          "telegram-bot.adapter.ts",
        // Telegram's own way of saying the method failed.
        "rejected"
      );
    }

    return parsed.result;
  }

  /**
   * Reads the field this adapter exists to produce, refusing anything that is not
   * a usable link.
   *
   * Phase 3's exact bug, transplanted: `String(result.invite_link)` on an
   * unrecognised 200 would yield the literal string "undefined", which the worker
   * would store on `channel_membership.invite_link` and WhatsApp to someone who
   * paid. For an adapter acknowledged as guesswork, an unrecognised shape must
   * fail loudly.
   *
   * The scheme check is here because the member is told to open it.
   *
   * Every refusal here is `"indeterminate"`, and that is the pessimistic answer on
   * purpose: these are all reached AFTER Telegram answered `ok: true`, so a link very
   * probably EXISTS and this adapter cannot read its value. That is precisely the
   * unkillable-orphan case (`revokeChatInviteLink` needs the value; no Bot API method
   * enumerates a bot's links), so the mint window must stay closed and a person must
   * reissue.
   */
  private requireInviteLink(result: unknown): string {
    if (!isRecord(result)) {
      throw new ProviderCallError(
        'telegram createChatInviteLink returned no result object, so it carries no "invite_link" ' +
          "(expected { ok: true, result: { invite_link } }) — see the UNVERIFIED warning in " +
          "telegram-bot.adapter.ts",
        "indeterminate"
      );
    }

    const value = result.invite_link;
    if (typeof value !== "string" || value.length === 0) {
      throw new ProviderCallError(
        'telegram createChatInviteLink returned a result with no usable "invite_link" ' +
          "(expected a non-empty string). The response shape does not match what this " +
          "adapter assumes — see the UNVERIFIED warning in telegram-bot.adapter.ts",
        "indeterminate"
      );
    }

    if (!value.startsWith("https://") && !value.startsWith("http://")) {
      throw new ProviderCallError(
        'telegram createChatInviteLink returned an "invite_link" that is not an http(s) URL. ' +
          "It is sent to a member to open, so a javascript: or data: value would be handed " +
          "straight to them. Refusing it.",
        "indeterminate"
      );
    }

    return value;
  }

  /**
   * Telegram addresses members by integer user id. Ours come out of
   * `channel_membership`, so a value that is not an integer means OUR record is
   * wrong — checking locally turns a confusing provider error ("user not found",
   * or worse, an action against a different account) into a clear one, and avoids
   * spending an HTTP call to learn it.
   *
   * `"rejected"`, because no request was made AT ALL: this runs before `call`, so
   * nothing can have been minted. It matters on the `grantAccess` path — a bad
   * `external_member_id` on the unban leg would otherwise be read as ambiguous and
   * permanently forbid minting for a member whose record is merely wrong, which is a
   * repairable problem that must not cost them their access forever.
   */
  private requireTelegramUserId(value: string): number {
    if (!TELEGRAM_USER_ID.test(value)) {
      throw new ProviderCallError(
        `telegram requires an integer user id, and "${value}" is not one. This is the ` +
          "provider member id recorded at grant time; a WhatsApp number or an empty value " +
          "here means our own record is wrong.",
        "rejected"
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new ProviderCallError(
        `telegram user id "${value}" is outside the safe integer range, so it cannot be ` +
          "sent without corruption.",
        "rejected"
      );
    }
    return parsed;
  }
}
