import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { activityLogs, channelMemberships, channels, members } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

let seq = 0;

/**
 * A creator with a community, a telegram channel, and a member holding active
 * access to it — i.e. exactly what a successful payment leaves behind.
 */
async function seedGrantedMember(
  a: ReturnType<typeof app>,
  token: string,
  options: { platform?: string; externalMemberId?: string | null } = {}
) {
  seq += 1;
  const created = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name: `Kelas ${seq}` }),
  });
  const community = await created.json();

  const [channel] = await db
    .insert(channels)
    .values({
      communityId: community.id,
      platform: options.platform ?? "telegram",
      externalGroupId: `-100${seq}${Date.now()}`,
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+628${seq}${Date.now()}`.slice(0, 15), name: "Siti" })
    .returning();
  const [membership] = await db
    .insert(channelMemberships)
    .values({
      memberId: member.id,
      channelId: channel.id,
      // Unique per seed, like a real invite link — and now REQUIRED to be:
      // `channel_membership_invite_link_unique` (Task 7b) makes the link the
      // unambiguous lookup key for recording a joining member's platform user id.
      inviteLink: `https://t.me/+granted-${seq}-${Date.now()}`,
      externalMemberId: options.externalMemberId ?? null,
    })
    .returning();

  return { community, channel, member, membership };
}

async function membershipById(id: string) {
  const [row] = await db.select().from(channelMemberships).where(eq(channelMemberships.id, id));
  return row;
}

describe("POST /communities/:communityId/members/:memberId/revoke", () => {
  it("revokes the member's access and says what it could and could not automate", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community, member, membership, channel } = await seedGrantedMember(a, token, {
      externalMemberId: "987654321",
    });

    const res = await a.request(`/communities/${community.id}/members/${member.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toBe(1);
    expect(body.automated).toBe(true);
    expect(body.channels).toEqual([
      { channelId: channel.id, platform: "telegram", automated: true },
    ]);

    const row = await membershipById(membership.id);
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).not.toBeNull();

    const logs = await db.select().from(activityLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe("channel_access_revoked");
  });

  it("never puts the invite link in the response", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community, member } = await seedGrantedMember(a, token, {
      externalMemberId: "987654321",
    });

    const res = await a.request(`/communities/${community.id}/members/${member.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
    });

    // The link belongs to the member who bought it. This response goes to the
    // creator.
    expect(await res.text()).not.toContain("t.me");
  });

  it("returns 404 for a stranger's token AND leaves the membership unchanged", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const { community, member, membership } = await seedGrantedMember(a, owner.token, {
      externalMemberId: "987654321",
    });
    const before = await membershipById(membership.id);

    const res = await a.request(`/communities/${community.id}/members/${member.id}/revoke`, {
      method: "POST",
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
    // Both halves, as Phase 2's authorization tests do: a 404 that still removed
    // the member would be worse than a 403 that did not.
    expect(await membershipById(membership.id)).toEqual(before);
    expect(await db.select().from(activityLogs)).toHaveLength(0);
  });

  it("returns 401 without a bearer token, and touches nothing", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community, member, membership } = await seedGrantedMember(a, token);

    const res = await a.request(`/communities/${community.id}/members/${member.id}/revoke`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
    expect((await membershipById(membership.id)).status).toBe("active");
  });

  it("returns 404 for a member with no active membership", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community, member } = await seedGrantedMember(a, token, {
      externalMemberId: "987654321",
    });
    const url = `/communities/${community.id}/members/${member.id}/revoke`;

    expect((await a.request(url, { method: "POST", headers: bearer(token) })).status).toBe(200);
    // The second click is not a second removal.
    expect((await a.request(url, { method: "POST", headers: bearer(token) })).status).toBe(404);
    expect(await db.select().from(activityLogs)).toHaveLength(1);
  });

  it("returns 404 for a member id that exists but never joined this community", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community } = await seedGrantedMember(a, token);
    const other = await seedGrantedMember(a, token);

    const res = await a.request(
      `/communities/${community.id}/members/${other.member.id}/revoke`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(404);
    expect((await membershipById(other.membership.id)).status).toBe("active");
  });

  it("reports honestly for a notify-only channel instead of claiming success", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community, member, membership } = await seedGrantedMember(a, token, {
      platform: "whatsapp",
    });

    const res = await a.request(`/communities/${community.id}/members/${member.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revoked).toBe(1);
    // The creator is told, in the response they are reading, that they have to
    // remove this member from the WhatsApp group themselves.
    expect(body.automated).toBe(false);
    expect(body.channels[0].reason).toBe("provider_cannot_gate_access");
    expect((await membershipById(membership.id)).status).toBe("revoked");
  });

  it("400s on a malformed community id or member id rather than 500ing", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const { community, member } = await seedGrantedMember(a, token);

    // `uuid = 'not-a-uuid'` is SQLSTATE 22P02 straight from the driver, which
    // would be a 500 on trivially reachable input.
    const badCommunity = await a.request(`/communities/not-a-uuid/members/${member.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
    });
    expect(badCommunity.status).toBe(400);

    const badMember = await a.request(
      `/communities/${community.id}/members/not-a-uuid/revoke`,
      { method: "POST", headers: bearer(token) }
    );
    expect(badMember.status).toBe(400);
  });

  it("does not shadow the community routes it is mounted in front of", async () => {
    // The nested mount must not swallow /communities itself — the same ordering
    // trap tiers and channels carry.
    const a = app();
    const { token } = await signupAndGetToken(a);
    await seedGrantedMember(a, token);

    const list = await a.request("/communities", { headers: bearer(token) });
    expect(list.status).toBe(200);
    expect((await list.json()).length).toBeGreaterThan(0);
  });
});
