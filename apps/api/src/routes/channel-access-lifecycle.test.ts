import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap, TEST_TELEGRAM_WEBHOOK_SECRET } from "../bootstrap";
import { bootstrapWorker } from "../worker-bootstrap";
import { db } from "../db/client";
import { channelMemberships, subscriptions, transactions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { FakeMessagingAdapter } from "../infrastructure/messaging/fake-messaging.adapter";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

const CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";
const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? TEST_TELEGRAM_WEBHOOK_SECRET;

/**
 * THE test Task 7b exists for.
 *
 * Before it, this whole path stopped one step short of working: `GrantChannelAccess`
 * issued an invite link, `RevokeChannelAccess` was built and tested — and for
 * Telegram it could never actually remove anybody, because `banChatMember` addresses
 * an integer USER ID and nothing in the system had ever recorded one.
 * `channel_membership.external_member_id` was NULL on every row, so revoke reported
 * `no_provider_member_id_recorded` and the creator did it by hand. That is the PRD's
 * #2 validated problem, unsolved.
 *
 * So this walks the ENTIRE path with no stubbing of the steps in between:
 *
 *   1. creator signs up, connects payments, creates a community, a tier, a channel
 *   2. a member checks out and Xendit's PAID webhook activates them (real HTTP)
 *   3. the WORKER drains the outbox and issues a real invite link through its own
 *      messaging adapter (a separate composition root — two processes, as deployed)
 *   4. Telegram delivers a `chat_member` join carrying THAT link to
 *      POST /webhooks/telegram (real HTTP, real secret verification)
 *   5. the creator calls POST /communities/:id/members/:id/revoke (real HTTP)
 *   6. the API's OWN messaging adapter recorded a `revokeAccess` with the user id
 *      step 4 recorded
 *
 * Step 6 is the assertion that separates a gating product that can remove people
 * from one that cannot. The link in step 4 is the one the adapter actually MINTED in
 * step 3, not a fixture — a hardcoded link would prove the webhook can match a
 * string, not that the pieces connect.
 */

/** Everything a member needs in order to have been granted access. */
async function grantedMember() {
  const deps = bootstrap();
  const api = createApp(deps);
  const { token, creatorId } = await signupAndGetToken(api);
  await api.request("/payment-account", { method: "POST", headers: bearer(token) });

  const community = await (
    await api.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Budi" }),
    })
  ).json();
  const tier = await (
    await api.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  const channel = await (
    await api.request(`/communities/${community.id}/channels`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        platform: "telegram",
        // A realistic supergroup id: `-100` plus 10 digits, so it survives a JSON
        // round trip as a safe integer (the parser refuses one that does not).
        externalGroupId: "-1001234567890",
      }),
    })
  ).json();

  const checkout = await (
    await api.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierId: tier.id,
        payerName: "Siti",
        payerWhatsappNumber: "+6281234567890",
      }),
    })
  ).json();

  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, checkout.transactionId));
  const paid = await api.request("/webhooks/xendit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CALLBACK-TOKEN": CALLBACK_TOKEN },
    body: JSON.stringify({
      id: tx.gatewayReferenceId,
      external_id: checkout.transactionId,
      status: "PAID",
      amount: 50000,
    }),
  });
  if (paid.status !== 200) {
    throw new Error(`activation failed in test setup: ${paid.status} ${await paid.text()}`);
  }

  // The WORKER grants — the API never issues an invite. Its own composition root,
  // so its own messaging adapters, exactly as the two processes are deployed.
  const worker = bootstrapWorker();
  const processed = await worker.processOutbox.execute();
  if (processed.sent !== 1) {
    throw new Error(`worker did not send the grant: ${JSON.stringify(processed)}`);
  }

  const [membership] = await db.select().from(channelMemberships);
  return {
    deps,
    api,
    token,
    creatorId,
    communityId: community.id,
    channel,
    membership,
    memberId: membership.memberId,
    // The link the fake adapter actually minted, read back off the row the worker
    // wrote. This is the join key Telegram will report.
    inviteLink: membership.inviteLink!,
    workerTelegram: worker.messaging.gating.get("telegram") as FakeMessagingAdapter,
  };
}

/** The Telegram adapter the API process itself selected — the one revoke calls. */
function apiTelegram(deps: ReturnType<typeof bootstrap>): FakeMessagingAdapter {
  return deps.messaging.gating.get("telegram") as FakeMessagingAdapter;
}

function chatMemberJoin(input: { chatId: string; userId: number; inviteLink: string }) {
  return {
    update_id: 7,
    chat_member: {
      chat: { id: Number(input.chatId), type: "supergroup", title: "Kelas Budi" },
      from: { id: input.userId, is_bot: false, first_name: "Siti" },
      date: 1_800_000_000,
      old_chat_member: { user: { id: input.userId, is_bot: false }, status: "left" },
      new_chat_member: {
        user: { id: input.userId, is_bot: false, first_name: "Siti" },
        status: "member",
      },
      invite_link: { invite_link: input.inviteLink, member_limit: 1 },
    },
  };
}

function postJoin(api: ReturnType<typeof createApp>, body: unknown) {
  return api.request("/webhooks/telegram", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_SECRET,
    },
    body: JSON.stringify(body),
  });
}

async function membershipById(id: string) {
  const [row] = await db.select().from(channelMemberships).where(eq(channelMemberships.id, id));
  return row;
}

describe("channel access lifecycle: pay -> grant -> join -> revoke", () => {
  it("REVOCATION GENUINELY BANS the member Telegram told us about", async () => {
    const ctx = await grantedMember();

    // Step 4: Telegram reports the join, carrying the link the worker minted.
    const join = await postJoin(
      ctx.api,
      chatMemberJoin({
        chatId: ctx.channel.externalGroupId,
        userId: 987654321,
        inviteLink: ctx.inviteLink,
      })
    );
    expect(join.status).toBe(200);
    expect((await membershipById(ctx.membership.id)).externalMemberId).toBe("987654321");

    // Step 5: the creator removes them.
    const revoke = await ctx.api.request(
      `/communities/${ctx.communityId}/members/${ctx.memberId}/revoke`,
      { method: "POST", headers: bearer(ctx.token) }
    );

    expect(revoke.status).toBe(200);
    const body = await revoke.json();
    // `automated: true` is the creator-visible claim, and it is only honest if the
    // provider was really called.
    expect(body.revoked).toBe(1);
    expect(body.automated).toBe(true);
    expect(body.channels[0].reason).toBeUndefined();

    // Step 6: THE assertion. The API's own adapter recorded a real revokeAccess,
    // addressed to the group and to the user id the join webhook recorded.
    expect(apiTelegram(ctx.deps).revocations).toEqual([
      { externalGroupId: "-1001234567890", externalMemberId: "987654321" },
    ]);
  });

  it("reports no_provider_member_id_recorded when the join never arrived", async () => {
    // The BEFORE state, kept as a test: without the `chat_member` update there is no
    // user id, so nothing can be banned and the creator must be told so rather than
    // being shown a removal that did not happen. This is what every Phase 4
    // revocation used to look like.
    const ctx = await grantedMember();

    const revoke = await ctx.api.request(
      `/communities/${ctx.communityId}/members/${ctx.memberId}/revoke`,
      { method: "POST", headers: bearer(ctx.token) }
    );

    const body = await revoke.json();
    expect(body.revoked).toBe(1);
    expect(body.automated).toBe(false);
    expect(body.channels[0].reason).toBe("no_provider_member_id_recorded");
    expect(apiTelegram(ctx.deps).revocations).toEqual([]);
  });

  it("does not ban anyone when the join reported a link that is not ours", async () => {
    const ctx = await grantedMember();

    await postJoin(
      ctx.api,
      chatMemberJoin({
        chatId: ctx.channel.externalGroupId,
        userId: 987654321,
        inviteLink: "https://t.me/+someone-elses-link",
      })
    );

    const revoke = await ctx.api.request(
      `/communities/${ctx.communityId}/members/${ctx.memberId}/revoke`,
      { method: "POST", headers: bearer(ctx.token) }
    );

    expect((await revoke.json()).channels[0].reason).toBe("no_provider_member_id_recorded");
    expect(apiTelegram(ctx.deps).revocations).toEqual([]);
  });

  it("does not ban anyone for an update that failed authentication", async () => {
    // The join webhook is the only way an `external_member_id` gets written, so a
    // forged update is a way to aim `banChatMember` at an arbitrary account.
    const ctx = await grantedMember();

    const forged = await ctx.api.request("/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "not-the-secret",
      },
      body: JSON.stringify(
        chatMemberJoin({
          chatId: ctx.channel.externalGroupId,
          userId: 666,
          inviteLink: ctx.inviteLink,
        })
      ),
    });

    expect(forged.status).toBe(401);
    expect((await membershipById(ctx.membership.id)).externalMemberId).toBeNull();

    const revoke = await ctx.api.request(
      `/communities/${ctx.communityId}/members/${ctx.memberId}/revoke`,
      { method: "POST", headers: bearer(ctx.token) }
    );
    expect((await revoke.json()).channels[0].reason).toBe("no_provider_member_id_recorded");
    expect(apiTelegram(ctx.deps).revocations).toEqual([]);
  });

  it("lets a member who re-pays back in: the re-grant asks for an unban first", async () => {
    // The other half of a working revocation. `banChatMember` also blocks the user
    // from joining via ANY link, so without the unban the fresh link a re-payer
    // receives silently does nothing — a permanent lockout created by the very
    // feature that made revocation work.
    const ctx = await grantedMember();
    await postJoin(
      ctx.api,
      chatMemberJoin({
        chatId: ctx.channel.externalGroupId,
        userId: 987654321,
        inviteLink: ctx.inviteLink,
      })
    );
    await ctx.api.request(
      `/communities/${ctx.communityId}/members/${ctx.memberId}/revoke`,
      { method: "POST", headers: bearer(ctx.token) }
    );

    // The member re-pays: the worker grants again for the same subscription. A fresh
    // worker, so its adapter has recorded nothing yet and `grants[0]` below is
    // unambiguously the RE-grant.
    const worker = bootstrapWorker();
    await worker.grantChannelAccess.execute({ subscriptionId: await onlySubscriptionId() });

    const telegram = worker.messaging.gating.get("telegram") as FakeMessagingAdapter;
    expect(telegram.grants).toHaveLength(1);
    // The id the join webhook recorded, handed back so the adapter can
    // unbanChatMember before it mints a link that would otherwise admit nobody.
    expect(telegram.grants[0].previousExternalMemberId).toBe("987654321");
  });
});

/** The one subscription the lifecycle helper created. */
async function onlySubscriptionId(): Promise<string> {
  const rows = await db.select().from(subscriptions);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}
