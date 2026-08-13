import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { joinRequests, outbox, subscriptions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

let phoneCounter = 0;
function freshWhatsappNumber(): string {
  phoneCounter += 1;
  return `+62811${String(1000000 + phoneCounter).padStart(7, "0")}`;
}

async function makeFreeCommunity(a: ReturnType<typeof app>, token: string, name = "Kelas Rina") {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name, accessMode: "request" }),
  });
  if (res.status !== 201) {
    throw new Error(`community create failed in test setup: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function makeTier(
  a: ReturnType<typeof app>,
  token: string,
  communityId: string,
  overrides: { name?: string; priceAmount?: number } = {}
) {
  const res = await a.request(`/communities/${communityId}/tiers`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      name: overrides.name ?? "Gratis",
      priceAmount: overrides.priceAmount ?? 0,
      billingCycle: "monthly",
    }),
  });
  if (res.status !== 201) {
    throw new Error(`tier create failed in test setup: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function submitJoinRequest(
  a: ReturnType<typeof app>,
  slug: string,
  tierId: string,
  overrides: { payerName?: string; payerWhatsappNumber?: string } = {}
) {
  const res = await a.request(`/c/${slug}/join-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tierId,
      payerName: overrides.payerName ?? "Siti",
      payerWhatsappNumber: overrides.payerWhatsappNumber ?? freshWhatsappNumber(),
    }),
  });
  if (res.status !== 201) {
    throw new Error(`join-request failed in test setup: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** A full owner + free community + tier + one pending request, ready to decide on. */
async function seedPendingRequest(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
  const community = await makeFreeCommunity(a, token);
  const tier = await makeTier(a, token, community.id);
  const { joinRequestId } = await submitJoinRequest(a, community.slug, tier.id);
  return { token, community, tier, joinRequestId };
}

describe("GET /communities/:id/join-requests", () => {
  it("lists pending requests for the owner", async () => {
    const a = app();
    const { token, community, tier } = await seedPendingRequest(a);
    // A second pending request, same community, so the list has more than one row.
    await submitJoinRequest(a, community.slug, tier.id, { payerName: "Budi" });

    const res = await a.request(`/communities/${community.id}/join-requests`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    const names = body.map((r: { memberName: string | null }) => r.memberName).sort();
    expect(names).toEqual(["Budi", "Siti"]);
    expect(body[0].tierId).toBe(tier.id);
  });

  it("returns an empty list for a community with no pending requests", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeFreeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/join-requests`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404s for a stranger — never 403", async () => {
    const a = app();
    const { community } = await seedPendingRequest(a);
    const stranger = await signupAndGetToken(a);

    const res = await a.request(`/communities/${community.id}/join-requests`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { community } = await seedPendingRequest(a);

    const res = await a.request(`/communities/${community.id}/join-requests`);

    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID communityId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/communities/not-a-uuid/join-requests", {
      headers: bearer(token),
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /communities/:id/join-requests/:requestId/approve", () => {
  it("approves for the owner: 200, an active subscription with a null next_billing_date, and exactly one grant_access row", async () => {
    const a = app();
    const { token, community, joinRequestId } = await seedPendingRequest(a);

    const res = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/approve`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.subscriptionId).toBe("string");

    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, body.subscriptionId));
    expect(subscription.status).toBe("active");
    expect(subscription.nextBillingDate).toBeNull();

    const grantRows = await db.select().from(outbox).where(eq(outbox.eventType, "grant_access"));
    expect(grantRows).toHaveLength(1);
    expect((grantRows[0].payload as { subscriptionId: string }).subscriptionId).toBe(
      body.subscriptionId
    );
  });

  it("removes the request from the pending list once approved", async () => {
    const a = app();
    const { token, community, joinRequestId } = await seedPendingRequest(a);

    await a.request(`/communities/${community.id}/join-requests/${joinRequestId}/approve`, {
      method: "POST",
      headers: bearer(token),
    });

    const res = await a.request(`/communities/${community.id}/join-requests`, {
      headers: bearer(token),
    });
    expect(await res.json()).toEqual([]);
  });

  it("approving twice enqueues exactly one grant_access row, and the second call 409s", async () => {
    const a = app();
    const { token, community, joinRequestId } = await seedPendingRequest(a);
    const url = `/communities/${community.id}/join-requests/${joinRequestId}/approve`;

    const first = await a.request(url, { method: "POST", headers: bearer(token) });
    expect(first.status).toBe(200);

    const second = await a.request(url, { method: "POST", headers: bearer(token) });
    expect(second.status).toBe(409);

    const grantRows = await db.select().from(outbox).where(eq(outbox.eventType, "grant_access"));
    expect(grantRows).toHaveLength(1);
  });

  it("404s for a creator who does not own the community — never 403", async () => {
    const a = app();
    const { community, joinRequestId } = await seedPendingRequest(a);
    const stranger = await signupAndGetToken(a);

    const res = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/approve`,
      { method: "POST", headers: bearer(stranger.token) }
    );

    expect(res.status).toBe(404);
  });

  it("404s a requestId that belongs to a different community, even one the same creator owns", async () => {
    const a = app();
    const { token, joinRequestId } = await seedPendingRequest(a);
    const otherCommunity = await makeFreeCommunity(a, token, "Kelas Lain");

    const res = await a.request(
      `/communities/${otherCommunity.id}/join-requests/${joinRequestId}/approve`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(404);
  });

  it("409s approving a request whose tier has been deactivated", async () => {
    const a = app();
    const { token, community, tier, joinRequestId } = await seedPendingRequest(a);

    const deactivate = await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivate.status).toBe(200);

    const res = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/approve`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(
      "tier ini sudah tidak aktif. Aktifkan kembali tier tersebut atau tolak permintaan ini."
    );
  });

  it("rejects a non-UUID requestId with 400, not 500", async () => {
    const a = app();
    const { token, community } = await seedPendingRequest(a);

    const res = await a.request(
      `/communities/${community.id}/join-requests/not-a-uuid/approve`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(400);
  });

  /**
   * The path RULING 2 names: the partial unique index on `join_request` only
   * covers `pending` rows, so once request 1 is approved a SECOND pending
   * request for the same (member, tier) is not something the schema itself
   * refuses. `RequestToJoin`'s own `hasLiveSubscriptionInCommunity` guard
   * refuses it at submission time — so a second row is inserted directly here,
   * the same way a lost race would produce one — to prove `DecideJoinRequest`'s
   * OWN guard (the graceful pre-check) answers correctly if that row ever
   * exists: 409 with the exact Indonesian message, no new subscription, and no
   * second `grant_access` row.
   */
  it("409s approving a second request for a tier the member already holds actively", async () => {
    const a = app();
    const { token, community, tier, joinRequestId } = await seedPendingRequest(a);

    const approveFirst = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/approve`,
      { method: "POST", headers: bearer(token) }
    );
    expect(approveFirst.status).toBe(200);

    const [firstRow] = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.id, joinRequestId));
    const [secondRow] = await db
      .insert(joinRequests)
      .values({ communityId: community.id, tierId: tier.id, memberId: firstRow.memberId })
      .returning();

    const res = await a.request(
      `/communities/${community.id}/join-requests/${secondRow.id}/approve`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("anggota ini sudah menjadi member aktif di tier tersebut.");

    // Still exactly one active subscription, and exactly one grant_access row —
    // the second approve attempt created neither.
    const activeSubs = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.memberId, firstRow.memberId));
    expect(activeSubs).toHaveLength(1);
    const grantRows = await db.select().from(outbox).where(eq(outbox.eventType, "grant_access"));
    expect(grantRows).toHaveLength(1);

    // And the second request is untouched — still pending, so the owner can
    // still reject it.
    const [reread] = await db.select().from(joinRequests).where(eq(joinRequests.id, secondRow.id));
    expect(reread.status).toBe("pending");
  });
});

describe("POST /communities/:id/join-requests/:requestId/reject", () => {
  it("rejects for the owner: 200, a null subscriptionId, and sends nothing", async () => {
    const a = app();
    const { token, community, joinRequestId } = await seedPendingRequest(a);

    const res = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/reject`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ subscriptionId: null });

    // No grant_access row — a rejection sends nothing, by design. (The single
    // outbox row that DOES exist is `notify_join_request`, enqueued when the
    // request was first submitted — Task 3 — and is not this decision's doing.)
    const grantRows = await db.select().from(outbox).where(eq(outbox.eventType, "grant_access"));
    expect(grantRows).toHaveLength(0);
    const allRows = await db.select().from(outbox);
    expect(allRows.map((r) => r.eventType)).toEqual(["notify_join_request"]);
  });

  it("removes the request from the pending list once rejected", async () => {
    const a = app();
    const { token, community, joinRequestId } = await seedPendingRequest(a);

    await a.request(`/communities/${community.id}/join-requests/${joinRequestId}/reject`, {
      method: "POST",
      headers: bearer(token),
    });

    const res = await a.request(`/communities/${community.id}/join-requests`, {
      headers: bearer(token),
    });
    expect(await res.json()).toEqual([]);
  });

  /**
   * Fix round 1: without this scoping, approving a deactivated-tier request
   * 409s with a message telling the owner to reject instead — and rejecting
   * used to hit the identical 409, a genuine deadlock with no escape that did
   * not require briefly reactivating (and republishing) a retired tier. This
   * is the escape hatch the message promises, proven end to end.
   */
  it("succeeds rejecting a request even when its tier has been deactivated", async () => {
    const a = app();
    const { token, community, tier, joinRequestId } = await seedPendingRequest(a);

    const deactivate = await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ isActive: false }),
    });
    expect(deactivate.status).toBe(200);

    const res = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/reject`,
      { method: "POST", headers: bearer(token) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscriptionId: null });
  });

  it("404s for a creator who does not own the community — never 403", async () => {
    const a = app();
    const { community, joinRequestId } = await seedPendingRequest(a);
    const stranger = await signupAndGetToken(a);

    const res = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/reject`,
      { method: "POST", headers: bearer(stranger.token) }
    );

    expect(res.status).toBe(404);
  });

  it("a member may submit a NEW request after rejection — no blocklist", async () => {
    const a = app();
    const { token, community, tier, joinRequestId } = await seedPendingRequest(a);
    // Read the rejected member's own WhatsApp number back so the re-request
    // comes from the SAME member, not a fresh one.
    const before = await a.request(`/communities/${community.id}/join-requests`, {
      headers: bearer(token),
    });
    const [{ memberWhatsappNumber }] = await before.json();

    const rejectRes = await a.request(
      `/communities/${community.id}/join-requests/${joinRequestId}/reject`,
      { method: "POST", headers: bearer(token) }
    );
    expect(rejectRes.status).toBe(200);

    const second = await submitJoinRequest(a, community.slug, tier.id, {
      payerWhatsappNumber: memberWhatsappNumber,
    });
    expect(typeof second.joinRequestId).toBe("string");
    expect(second.joinRequestId).not.toBe(joinRequestId);
  });
});
