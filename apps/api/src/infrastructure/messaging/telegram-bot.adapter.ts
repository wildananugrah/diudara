import { UnsupportedOperationError } from "../../application/errors";
import type {
  GrantAccessInput,
  MessagingCapabilities,
  MessagingProviderPort,
  NotifyInput,
  RevokeAccessInput,
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
   * One Bot API call, with every failure turned into a throw.
   *
   * Telegram reports plenty of failures as HTTP 200 with `ok: false`, so the
   * status check alone is not enough — and returning a "successful" result from an
   * unrecognised body is how `String(body.id)` produced the literal invite link
   * "undefined" in Phase 3.
   */
  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `telegram ${method} failed with status ${response.status} ` +
          "(no request or response detail is included on purpose: the bot token is part " +
          "of every Bot API request path)"
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error(
        `telegram ${method} returned a 200 whose body is not JSON — most likely a proxy ` +
          "or error page rather than the Bot API"
      );
    }

    if (!isRecord(parsed) || parsed.ok !== true) {
      throw new Error(
        `telegram ${method} failed: the response does not carry "ok": true. The provider ` +
          "description is deliberately not repeated here — see the SECRET HANDLING note in " +
          "telegram-bot.adapter.ts"
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
   */
  private requireInviteLink(result: unknown): string {
    if (!isRecord(result)) {
      throw new Error(
        'telegram createChatInviteLink returned no result object, so it carries no "invite_link" ' +
          "(expected { ok: true, result: { invite_link } }) — see the UNVERIFIED warning in " +
          "telegram-bot.adapter.ts"
      );
    }

    const value = result.invite_link;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        'telegram createChatInviteLink returned a result with no usable "invite_link" ' +
          "(expected a non-empty string). The response shape does not match what this " +
          "adapter assumes — see the UNVERIFIED warning in telegram-bot.adapter.ts"
      );
    }

    if (!value.startsWith("https://") && !value.startsWith("http://")) {
      throw new Error(
        'telegram createChatInviteLink returned an "invite_link" that is not an http(s) URL. ' +
          "It is sent to a member to open, so a javascript: or data: value would be handed " +
          "straight to them. Refusing it."
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
   */
  private requireTelegramUserId(value: string): number {
    if (!TELEGRAM_USER_ID.test(value)) {
      throw new Error(
        `telegram requires an integer user id, and "${value}" is not one. This is the ` +
          "provider member id recorded at grant time; a WhatsApp number or an empty value " +
          "here means our own record is wrong."
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `telegram user id "${value}" is outside the safe integer range, so it cannot be ` +
          "sent without corruption."
      );
    }
    return parsed;
  }
}
