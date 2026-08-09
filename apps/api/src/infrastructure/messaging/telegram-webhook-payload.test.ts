import { describe, expect, it } from "bun:test";
import { parseTelegramChatMemberJoin } from "./telegram-webhook-payload";

const CHAT_ID = -1_001_234_567_890;
const USER_ID = 987_654_321;
const INVITE_LINK = "https://t.me/+AbCdEfGhIjKl";

/**
 * Marks "leave this field at its default". A plain `undefined` cannot: `undefined`
 * is itself one of the values these tests need to send, and `?? default` would
 * quietly turn it back into a valid link.
 */
const DEFAULT = Symbol("default");

function join(
  overrides: { chat?: unknown; newChatMember?: unknown; inviteLink?: unknown } = {}
) {
  const chat = "chat" in overrides ? overrides.chat : DEFAULT;
  const newChatMember = "newChatMember" in overrides ? overrides.newChatMember : DEFAULT;
  const inviteLink = "inviteLink" in overrides ? overrides.inviteLink : DEFAULT;
  return {
    update_id: 1,
    chat_member: {
      chat: chat === DEFAULT ? { id: CHAT_ID, type: "supergroup", title: "Kelas" } : chat,
      from: { id: USER_ID, is_bot: false, first_name: "Siti" },
      date: 1_800_000_000,
      old_chat_member: { user: { id: USER_ID, is_bot: false }, status: "left" },
      new_chat_member:
        newChatMember === DEFAULT
          ? { user: { id: USER_ID, is_bot: false, first_name: "Siti" }, status: "member" }
          : newChatMember,
      invite_link:
        inviteLink === DEFAULT
          ? { invite_link: INVITE_LINK, member_limit: 1 }
          : inviteLink,
    },
  };
}

describe("parseTelegramChatMemberJoin", () => {
  it("extracts the chat id, the member id and the invite link", () => {
    expect(parseTelegramChatMemberJoin(join())).toEqual({
      chatId: String(CHAT_ID),
      externalMemberId: String(USER_ID),
      inviteLink: INVITE_LINK,
    });
  });

  it("accepts every status that means the user is IN the chat", () => {
    for (const status of ["member", "administrator", "creator"]) {
      const parsed = parseTelegramChatMemberJoin(
        join({ newChatMember: { user: { id: USER_ID }, status } })
      );
      expect(parsed?.externalMemberId).toBe(String(USER_ID));
    }
  });

  it("treats `restricted` as a join only when is_member is true", () => {
    // Telegram's documented quirk: a restricted user may or may not be in the chat,
    // and the status string alone does not say which.
    expect(
      parseTelegramChatMemberJoin(
        join({ newChatMember: { user: { id: USER_ID }, status: "restricted", is_member: true } })
      )
    ).not.toBeNull();
    expect(
      parseTelegramChatMemberJoin(
        join({ newChatMember: { user: { id: USER_ID }, status: "restricted", is_member: false } })
      )
    ).toBeNull();
  });

  it("returns null for a DEPARTURE", () => {
    for (const status of ["left", "kicked"]) {
      expect(
        parseTelegramChatMemberJoin(join({ newChatMember: { user: { id: USER_ID }, status } }))
      ).toBeNull();
    }
  });

  it("returns null for a status Telegram has not invented yet", () => {
    // JOINED_STATUSES is an ALLOWLIST for the same reason as RELAXED_NODE_ENVS: an
    // unanticipated value must not be read as a join.
    expect(
      parseTelegramChatMemberJoin(
        join({ newChatMember: { user: { id: USER_ID }, status: "shadow_banned" } })
      )
    ).toBeNull();
  });

  it("returns null when there is no invite_link to key on", () => {
    // A member an admin added by hand, or one who used the chat's primary link.
    // Real, and there is nothing to attach the id to.
    for (const link of [null, undefined, {}, { invite_link: "" }, { invite_link: 7 }, "str"]) {
      expect(parseTelegramChatMemberJoin(join({ inviteLink: link }))).toBeNull();
    }
  });

  it("returns null for an update that is not a chat_member at all", () => {
    for (const body of [
      {},
      { update_id: 1 },
      { update_id: 1, message: { text: "hi" } },
      { update_id: 1, my_chat_member: { chat: { id: CHAT_ID } } },
      { chat_member: null },
      { chat_member: "join" },
      [],
      "chat_member",
      null,
      undefined,
      42,
    ]) {
      expect(parseTelegramChatMemberJoin(body)).toBeNull();
    }
  });

  /**
   * Found by a test fixture, not by inspection: a chat id built as
   * `-100${Date.now()}` is 17 digits, past Number.MAX_SAFE_INTEGER, and JSON has
   * ALREADY rounded it by the time this function sees it. Stringifying a rounded
   * value would write a group id that addresses no group — and for a user id, one
   * that addresses the wrong account.
   */
  it("refuses an id outside the safe integer range rather than corrupting it", () => {
    expect(
      parseTelegramChatMemberJoin(join({ chat: { id: -1_001_754_783_123_456_789 } }))
    ).toBeNull();
    expect(
      parseTelegramChatMemberJoin(
        join({ newChatMember: { user: { id: 9_007_199_254_740_993 }, status: "member" } })
      )
    ).toBeNull();
  });

  it("refuses an id that is not a number, and a fractional one", () => {
    for (const id of ["987654321", null, 1.5, true, {}]) {
      expect(
        parseTelegramChatMemberJoin(join({ newChatMember: { user: { id }, status: "member" } }))
      ).toBeNull();
      expect(parseTelegramChatMemberJoin(join({ chat: { id } }))).toBeNull();
    }
  });

  it("keeps a negative supergroup chat id negative", () => {
    // `-100...` is the shape of every supergroup id, and `channel.external_group_id`
    // stores it verbatim. Dropping the sign would match no channel.
    expect(parseTelegramChatMemberJoin(join())?.chatId).toBe("-1001234567890");
  });
});
