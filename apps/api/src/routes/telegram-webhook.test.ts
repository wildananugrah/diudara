import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap, TEST_TELEGRAM_WEBHOOK_SECRET } from "../bootstrap";
import { db } from "../db/client";
import { channelMemberships, channels, communities, creators, members } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? TEST_TELEGRAM_WEBHOOK_SECRET;

let seq = 0;

/**
 * A granted membership: the state `GrantChannelAccess` leaves behind. The invite
 * link is the JOIN KEY — Phase 4 issues a single-use link per member, so the link
 * Telegram reports back identifies exactly one `channel_membership` row.
 */
async function seedGrantedMembership(options: { inviteLink?: string } = {}) {
  seq += 1;
  const [creator] = await db
    .insert(creators)
    .values({ name: "Budi", email: `b-${seq}-${Date.now()}@example.com` })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({ creatorId: creator.id, name: "Kelas", slug: `kelas-${seq}-${Date.now()}` })
    .returning();
  const [channel] = await db
    .insert(channels)
    .values({
      communityId: community.id,
      platform: "telegram",
      // Shaped like a real supergroup id: `-100` plus 10 digits, ~1e13, which fits
      // in a JSON number. Not `-100${Date.now()}` — that is 17 digits, past
      // Number.MAX_SAFE_INTEGER, and the parser rightly refuses it because JSON
      // has already rounded it by the time we see it.
      externalGroupId: `-100${String(1_000_000_000 + seq)}`,
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${seq}${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  const inviteLink = options.inviteLink ?? `https://t.me/+granted-${seq}-${Date.now()}`;
  const [membership] = await db
    .insert(channelMemberships)
    .values({ memberId: member.id, channelId: channel.id, inviteLink })
    .returning();
  return { creator, community, channel, member, membership, inviteLink };
}

/**
 * A `chat_member` update of the shape Telegram sends when a user joins through an
 * invite link. `invite_link` is the field this whole feature turns on: it is how a
 * Telegram user id gets attached to the membership we issued the link for.
 */
function chatMemberJoin(input: {
  chatId: string;
  userId: number;
  inviteLink: string;
  status?: string;
}) {
  return {
    update_id: 1000 + Math.floor(Math.random() * 1000),
    chat_member: {
      chat: { id: Number(input.chatId), type: "supergroup", title: "Kelas" },
      from: { id: input.userId, is_bot: false, first_name: "Siti" },
      date: 1_800_000_000,
      old_chat_member: { user: { id: input.userId, is_bot: false }, status: "left" },
      new_chat_member: {
        user: { id: input.userId, is_bot: false, first_name: "Siti" },
        status: input.status ?? "member",
      },
      invite_link: {
        invite_link: input.inviteLink,
        creator: { id: 42, is_bot: true, first_name: "Bot" },
        member_limit: 1,
        creates_join_request: false,
        is_primary: false,
        is_revoked: false,
      },
    },
  };
}

function post(a: ReturnType<typeof app>, body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return a.request("/webhooks/telegram", { method: "POST", headers, body: JSON.stringify(body) });
}

async function membershipById(id: string) {
  const [row] = await db.select().from(channelMemberships).where(eq(channelMemberships.id, id));
  return row;
}

describe("POST /webhooks/telegram", () => {
  /**
   * Task 7b, THE point. `channel_membership.external_member_id` existed (migration
   * 0007) and nothing populated it, so `RevokeChannelAccess` could report only
   * `no_provider_member_id_recorded` — the PRD's #2 validated problem ("no
   * systematic way to handle members who stop paying") was unsolvable for Telegram.
   */
  it("records the joining member's Telegram user id against the membership", async () => {
    const a = app();
    const { channel, membership, inviteLink } = await seedGrantedMembership();
    expect((await membershipById(membership.id)).externalMemberId).toBeNull();

    const res = await post(
      a,
      chatMemberJoin({ chatId: channel.externalGroupId!, userId: 987654321, inviteLink })
    );

    expect(res.status).toBe(200);
    expect((await membershipById(membership.id)).externalMemberId).toBe("987654321");
  });

  it("is idempotent: the same update twice changes nothing and does not fail", async () => {
    // Telegram retries an update it did not get a 2xx for, and can redeliver one it
    // did. Arbitrated by the conditional UPDATE, not by a pre-check.
    const a = app();
    const { channel, membership, inviteLink } = await seedGrantedMembership();
    const update = chatMemberJoin({
      chatId: channel.externalGroupId!,
      userId: 987654321,
      inviteLink,
    });

    expect((await post(a, update)).status).toBe(200);
    const after = await membershipById(membership.id);
    expect((await post(a, update)).status).toBe(200);

    expect(await membershipById(membership.id)).toEqual(after);
    expect((await db.select().from(channelMemberships))).toHaveLength(1);
  });

  it("ignores an unknown invite link without failing", async () => {
    const a = app();
    const { channel } = await seedGrantedMembership();

    const res = await post(
      a,
      chatMemberJoin({
        chatId: channel.externalGroupId!,
        userId: 1,
        inviteLink: "https://t.me/+never-issued-by-us",
      })
    );

    // A 2xx: a link we do not recognise is not something Telegram can fix by
    // retrying, and a non-2xx would make it retry forever.
    expect(res.status).toBe(200);
    const rows = await db.select().from(channelMemberships);
    expect(rows.every((row) => row.externalMemberId === null)).toBe(true);
  });

  it("never puts the invite link in a log line or the response", async () => {
    // An invite link is a BEARER CREDENTIAL (plan, Global Constraints). This route
    // receives one on every join, which makes it the easiest place in the codebase
    // to leak one.
    const a = app();
    const { channel } = await seedGrantedMembership();
    const secretLink = "https://t.me/+this-must-never-be-logged";

    const warnings: string[] = [];
    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let body: string;
    try {
      const res = await post(
        a,
        chatMemberJoin({ chatId: channel.externalGroupId!, userId: 5, inviteLink: secretLink })
      );
      body = await res.text();
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }

    const output = [...warnings, ...logs].join("\n");
    expect(output).not.toContain(secretLink);
    expect(output).not.toContain("this-must-never-be-logged");
    expect(body).not.toContain("this-must-never-be-logged");
  });

  describe("authentication", () => {
    it("rejects a wrong secret with 401 and records nothing", async () => {
      const a = app();
      const { channel, membership, inviteLink } = await seedGrantedMembership();

      const res = await post(
        a,
        chatMemberJoin({ chatId: channel.externalGroupId!, userId: 987654321, inviteLink }),
        "wrong-secret"
      );

      expect(res.status).toBe(401);
      expect((await membershipById(membership.id)).externalMemberId).toBeNull();
    });

    it("rejects a missing secret header with 401", async () => {
      const a = app();
      const { channel, membership, inviteLink } = await seedGrantedMembership();

      const res = await post(
        a,
        chatMemberJoin({ chatId: channel.externalGroupId!, userId: 987654321, inviteLink }),
        null
      );

      expect(res.status).toBe(401);
      expect((await membershipById(membership.id)).externalMemberId).toBeNull();
    });

    it("rejects an empty secret header with 401", async () => {
      // The Xendit lesson: an empty configured token used to match an empty header.
      const a = app();
      const { channel, inviteLink } = await seedGrantedMembership();

      expect(
        (
          await post(
            a,
            chatMemberJoin({ chatId: channel.externalGroupId!, userId: 1, inviteLink }),
            ""
          )
        ).status
      ).toBe(401);
    });

    it("rejects a secret that is a PREFIX or an extension of the real one", async () => {
      const a = app();
      const { channel, inviteLink } = await seedGrantedMembership();
      const update = chatMemberJoin({ chatId: channel.externalGroupId!, userId: 1, inviteLink });

      expect((await post(a, update, SECRET.slice(0, -1))).status).toBe(401);
      expect((await post(a, update, `${SECRET}x`)).status).toBe(401);
    });

    it("checks the secret BEFORE parsing the body", async () => {
      const a = app();
      const res = await a.request("/webhooks/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("updates that are not a join", () => {
    it("200s and does nothing for an update with no chat_member at all", async () => {
      // Telegram delivers whatever the bot's allowed_updates permits, and a
      // deployment may widen that later. Anything unrecognised must be a quiet 2xx.
      const a = app();
      const { membership } = await seedGrantedMembership();

      for (const body of [
        {},
        { update_id: 1 },
        { update_id: 1, message: { text: "hello" } },
        { update_id: 1, my_chat_member: { chat: { id: -1 } } },
        [],
        "chat_member",
      ]) {
        expect((await post(a, body)).status).toBe(200);
      }
      expect((await membershipById(membership.id)).externalMemberId).toBeNull();
    });

    it("200s and does nothing when the member LEFT rather than joined", async () => {
      const a = app();
      const { channel, membership, inviteLink } = await seedGrantedMembership();

      const res = await post(
        a,
        chatMemberJoin({
          chatId: channel.externalGroupId!,
          userId: 987654321,
          inviteLink,
          status: "left",
        })
      );

      expect(res.status).toBe(200);
      expect((await membershipById(membership.id)).externalMemberId).toBeNull();
    });

    it("200s and does nothing when the join carried no invite_link", async () => {
      // Someone added by an admin by hand, or joined via the primary link. There is
      // no join key, so there is nothing to attach the id to.
      const a = app();
      const { channel, membership } = await seedGrantedMembership();
      const update = chatMemberJoin({
        chatId: channel.externalGroupId!,
        userId: 987654321,
        inviteLink: "unused",
      }) as Record<string, any>;
      delete update.chat_member.invite_link;

      expect((await post(a, update)).status).toBe(200);
      expect((await membershipById(membership.id)).externalMemberId).toBeNull();
    });

    it("400s a body that is not valid JSON", async () => {
      const a = app();
      const res = await a.request("/webhooks/telegram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });

  it("does not overwrite an id already recorded for a DIFFERENT user", async () => {
    // The link is single-use, so this should be impossible. If it happens, our
    // record and Telegram's disagree, and silently rewriting the id would point
    // `banChatMember` at whichever account reported last.
    const a = app();
    const { channel, membership, inviteLink } = await seedGrantedMembership();
    await post(
      a,
      chatMemberJoin({ chatId: channel.externalGroupId!, userId: 111, inviteLink })
    );

    const res = await post(
      a,
      chatMemberJoin({ chatId: channel.externalGroupId!, userId: 222, inviteLink })
    );

    expect(res.status).toBe(200);
    expect((await membershipById(membership.id)).externalMemberId).toBe("111");
  });
});
