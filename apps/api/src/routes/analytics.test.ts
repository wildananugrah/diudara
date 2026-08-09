import { describe, expect, it, beforeEach } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { db } from "../db/client";
import { activityLogs, members, subscriptions, transactions } from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

type App = ReturnType<typeof app>;

async function makeCommunity(a: App, token: string, name = "Kelas Budi") {
  const res = await a.request("/communities", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`makeCommunity: ${res.status} ${await res.text()}`);
  return res.json();
}

async function makeTier(
  a: App,
  token: string,
  communityId: string,
  input: { name: string; priceAmount: number }
) {
  const res = await a.request(`/communities/${communityId}/tiers`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ ...input, billingCycle: "monthly" }),
  });
  if (res.status !== 201) throw new Error(`makeTier: ${res.status} ${await res.text()}`);
  return res.json();
}

let seedCounter = 0;

/**
 * A member with a subscription in an explicit status, inserted straight into the
 * database. The full checkout + webhook path is exercised elsewhere; these tests
 * are about what the analytics reads report, so the states they must report on are
 * set up directly.
 */
async function seedMemberWithSubscription(
  tierId: string,
  status: string,
  overrides: { name?: string } = {}
) {
  seedCounter += 1;
  const [member] = await db
    .insert(members)
    .values({
      whatsappNumber: `+62811${String(seedCounter).padStart(7, "0")}`,
      name: overrides.name ?? `Member ${seedCounter}`,
    })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member.id, tierId, status })
    .returning();
  return { member, subscription };
}

async function seedTransaction(subscriptionId: string, amount: number, status: string) {
  await db
    .insert(transactions)
    .values({ subscriptionId, amount, status, paymentMethod: "qris" })
    .returning();
}

describe("GET /communities/:communityId/metrics", () => {
  it("reports member counts, gross revenue and tier distribution", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const basic = await makeTier(a, token, community.id, { name: "Basic", priceAmount: 50_000 });
    await makeTier(a, token, community.id, { name: "VIP", priceAmount: 250_000 });

    const active = await seedMemberWithSubscription(basic.id, "active");
    await seedMemberWithSubscription(basic.id, "past_due");
    await seedMemberWithSubscription(basic.id, "churned");
    await seedTransaction(active.subscription.id, 50_000, "success");
    await seedTransaction(active.subscription.id, 999_999, "pending");

    const res = await a.request(`/communities/${community.id}/metrics`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toEqual({ active: 1, pastDue: 1, churned: 1 });
    expect(body.grossRevenueAmount).toBe(50_000);
    expect(body.tierDistribution).toEqual([
      { tierId: basic.id, tierName: "Basic", priceAmount: 50_000, activeMembers: 1 },
      {
        tierId: body.tierDistribution[1].tierId,
        tierName: "VIP",
        priceAmount: 250_000,
        activeMembers: 0,
      },
    ]);
  });

  it("names the revenue field so it cannot be mislabelled as net", async () => {
    // Xendit's split rule deducts DIUDARA's fee before the creator receives
    // anything, so this figure is GROSS. Task 7 has to label it as such, and a
    // field called `revenue` would invite presenting it as the creator's income.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const body = await (
      await a.request(`/communities/${community.id}/metrics`, { headers: bearer(token) })
    ).json();

    expect(Object.keys(body)).toContain("grossRevenueAmount");
    expect(Object.keys(body)).not.toContain("revenue");
    expect(Object.keys(body)).not.toContain("revenueAmount");
  });

  it("returns 404 for another creator's community and leaks nothing about it", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);
    const tier = await makeTier(a, owner.token, community.id, {
      name: "Kelas Rahasia VIP",
      priceAmount: 987_654,
    });
    const paid = await seedMemberWithSubscription(tier.id, "active", { name: "Siti Rahasia" });
    await seedTransaction(paid.subscription.id, 987_654, "success");

    const res = await a.request(`/communities/${community.id}/metrics`, {
      headers: bearer(stranger.token),
    });

    // 404, never 403: a 403 would confirm the community exists.
    expect(res.status).toBe(404);

    const text = await res.text();
    expect(text).not.toContain("Kelas Rahasia VIP");
    expect(text).not.toContain("Siti Rahasia");
    expect(text).not.toContain("987654");
    expect(text).not.toContain(paid.member.id);
    expect(text).not.toContain(tier.id);
    // No member count either — and rather than guessing which number might leak,
    // assert the body carries NO digits at all.
    expect(text).not.toMatch(/[0-9]/);
  });

  it("returns 404 for a community that does not exist", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const res = await a.request("/communities/00000000-0000-4000-8000-000000000000/metrics", {
      headers: bearer(token),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const res = await a.request(`/communities/${community.id}/metrics`);
    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID communityId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const res = await a.request("/communities/not-a-uuid/metrics", { headers: bearer(token) });
    expect(res.status).toBe(400);
  });

  it("still answers 401 before validating the params", async () => {
    const res = await app().request("/communities/not-a-uuid/metrics");
    expect(res.status).toBe(401);
  });
});

describe("mounting the analytics routes under /communities", () => {
  it("leaves the existing /communities collection endpoints working", async () => {
    // The analytics sub-app is mounted at `/communities`, so a `use("*")` inside it
    // would also match `GET /communities` and `POST /communities` — and its
    // communityId param check would then 400 both of them. Probed for real: Hono
    // composes EVERY matching handler, and `*` mounted at `/communities` matches
    // `/communities` itself. Its middleware is therefore per-route, and this test
    // is what would notice a `use("*")` creeping back in.
    const a = app();
    const { token } = await signupAndGetToken(a);
    await makeCommunity(a, token, "Kelas Satu");

    const listed = await a.request("/communities", { headers: bearer(token) });
    expect(listed.status).toBe(200);
    expect((await listed.json()).length).toBe(1);

    const created = await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Dua" }),
    });
    expect(created.status).toBe(201);
  });
});

// ===========================================================================
// Task 3: GET /communities/:communityId/activity
// ===========================================================================

/**
 * One `activity_log` row with an explicit `created_at`. Explicit because
 * `defaultNow()` is the TRANSACTION timestamp, so rows written together share it —
 * and the keyset tests below are about exactly that boundary.
 */
async function seedActivity(
  communityId: string,
  eventType: string,
  options: { createdAt?: Date; memberId?: string | null; metadata?: unknown } = {}
) {
  const [row] = await db
    .insert(activityLogs)
    .values({
      communityId,
      eventType,
      memberId: options.memberId ?? null,
      metadata: options.metadata ?? null,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning();
  return row;
}

function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 7, 10, 0, 0, seconds));
}

describe("GET /communities/:communityId/activity", () => {
  it("returns creator-facing events, newest first, with Indonesian labels", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const basic = await makeTier(a, token, community.id, { name: "Basic", priceAmount: 50_000 });
    const joiner = await seedMemberWithSubscription(basic.id, "active", { name: "Siti Aminah" });

    await seedActivity(community.id, "joined", {
      createdAt: at(1),
      memberId: joiner.member.id,
      metadata: { amount: 50_000 },
    });
    await seedActivity(community.id, "channel_access_granted", {
      createdAt: at(2),
      memberId: joiner.member.id,
      metadata: { platform: "telegram" },
    });

    const res = await a.request(`/communities/${community.id}/activity`, {
      headers: bearer(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].eventType).toBe("channel_access_granted");
    expect(body.entries[0].label).toContain("Telegram");
    expect(body.entries[0].severity).toBe("info");
    expect(body.entries[1].eventType).toBe("joined");
    expect(body.entries[1].label).toContain("bergabung");
    expect(body.entries[1].memberName).toBe("Siti Aminah");
    expect(body.nextCursor).toBeNull();
  });

  it("produces exactly ONE entry for one reminder", async () => {
    // A reminder writes `renewal_reminder_queued` AND `renewal_reminder_sent`. Only
    // `_sent` means the member was told. Two entries here would double every
    // reminder figure a creator ever reads, invisibly.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const basic = await makeTier(a, token, community.id, { name: "Basic", priceAmount: 50_000 });
    const member = await seedMemberWithSubscription(basic.id, "past_due");

    await seedActivity(community.id, "renewal_reminder_queued", {
      createdAt: at(1),
      memberId: member.member.id,
      metadata: { stage: "overdue_3d" },
    });
    await seedActivity(community.id, "renewal_reminder_sent", {
      createdAt: at(2),
      memberId: member.member.id,
      metadata: { stage: "overdue_3d" },
    });

    const body = await (
      await a.request(`/communities/${community.id}/activity`, { headers: bearer(token) })
    ).json();

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].eventType).toBe("renewal_reminder_sent");
    expect(body.entries[0].label).toContain("terlambat 3 hari");
  });

  it("never shows an internal diagnostic", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    for (const [index, hidden] of [
      "renewal_reminder_queued",
      "renewal_reminder_skipped",
      "renewal_reminder_not_sent",
      "access_not_granted",
      "access_not_revoked",
      "churn_revoke_skipped",
    ].entries()) {
      await seedActivity(community.id, hidden, { createdAt: at(index + 1) });
    }

    const res = await a.request(`/communities/${community.id}/activity`, {
      headers: bearer(token),
    });
    const text = await res.text();
    expect(JSON.parse(text).entries).toEqual([]);
    // And not merely filtered out of `entries` — the raw body must not carry the
    // diagnostic type names anywhere.
    expect(text).not.toContain("access_not_revoked");
    expect(text).not.toContain("churn_revoke_skipped");
  });

  it("surfaces the two *_manual_required events as warnings", async () => {
    // These mean automation could not complete and a human must act, which is the one
    // thing in this feed a creator must not miss.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    await seedActivity(community.id, "access_manual_required", {
      createdAt: at(1),
      metadata: { reason: "mint_lost" },
    });
    await seedActivity(community.id, "revocation_manual_required", {
      createdAt: at(2),
      metadata: { reason: "no_provider_member_id_recorded" },
    });

    const body = await (
      await a.request(`/communities/${community.id}/activity`, { headers: bearer(token) })
    ).json();

    expect(body.entries.map((e: { severity: string }) => e.severity)).toEqual([
      "warning",
      "warning",
    ]);
  });

  it("does not report a renewal as a new member", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    await seedActivity(community.id, "renewed", { createdAt: at(1), metadata: { amount: 50_000 } });

    const body = await (
      await a.request(`/communities/${community.id}/activity`, { headers: bearer(token) })
    ).json();

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].eventType).toBe("renewed");
    expect(body.entries[0].label).not.toContain("bergabung");
  });

  it("paginates by keyset, skipping and duplicating nothing when a row arrives mid-read", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const seeded = [];
    for (let i = 1; i <= 5; i++) {
      seeded.push(await seedActivity(community.id, "joined", { createdAt: at(i) }));
    }
    const newestFirst = [...seeded].reverse().map((row) => row.id);

    const page1 = await (
      await a.request(`/communities/${community.id}/activity?limit=2`, { headers: bearer(token) })
    ).json();
    expect(page1.entries.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();

    // A payment settles between the two "load more" clicks. With OFFSET this row
    // would push everything down one, so page 2 would repeat page 1's last row and
    // one of the originals would never be seen.
    const interloper = await seedActivity(community.id, "joined", { createdAt: at(99) });

    const page2 = await (
      await a.request(
        `/communities/${community.id}/activity?limit=2&before=${encodeURIComponent(page1.nextCursor)}`,
        { headers: bearer(token) }
      )
    ).json();
    expect(page2.entries.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(2, 4));

    const page3 = await (
      await a.request(
        `/communities/${community.id}/activity?limit=2&before=${encodeURIComponent(page2.nextCursor)}`,
        { headers: bearer(token) }
      )
    ).json();
    expect(page3.entries.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(4));
    expect(page3.nextCursor).toBeNull();

    const seen = [...page1.entries, ...page2.entries, ...page3.entries].map(
      (e: { id: string }) => e.id
    );
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(newestFirst);
    expect(seen).not.toContain(interloper.id);
  });

  it("reports nextCursor as null on the last page rather than an empty page later", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    await seedActivity(community.id, "joined", { createdAt: at(1) });
    await seedActivity(community.id, "joined", { createdAt: at(2) });

    const page = await (
      await a.request(`/communities/${community.id}/activity?limit=2`, { headers: bearer(token) })
    ).json();
    expect(page.entries).toHaveLength(2);
    // Exactly `limit` rows and nothing beyond them: the cursor must be null, or the
    // UI shows a "load more" button that fetches an empty page.
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor with 400 rather than restarting at page 1", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);

    const res = await a.request(`/communities/${community.id}/activity?before=not-a-cursor`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a limit that is not a positive integer, and caps a huge one", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    for (let i = 1; i <= 5; i++) {
      await seedActivity(community.id, "joined", { createdAt: at(i) });
    }

    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await a.request(`/communities/${community.id}/activity?limit=${bad}`, {
        headers: bearer(token),
      });
      expect(res.status).toBe(400);
    }

    // An unbounded limit is a way to make the API read a creator's whole history into
    // memory in one request, so it is refused rather than silently clamped.
    const tooBig = await a.request(`/communities/${community.id}/activity?limit=100000`, {
      headers: bearer(token),
    });
    expect(tooBig.status).toBe(400);
  });

  it("returns 404 for another creator's community and leaks no member identifier", async () => {
    const a = app();
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    const community = await makeCommunity(a, owner.token);
    const tier = await makeTier(a, owner.token, community.id, {
      name: "Kelas Rahasia VIP",
      priceAmount: 987_654,
    });
    const member = await seedMemberWithSubscription(tier.id, "active", { name: "Siti Rahasia" });
    await seedActivity(community.id, "joined", {
      createdAt: at(1),
      memberId: member.member.id,
      metadata: { amount: 987_654 },
    });

    const res = await a.request(`/communities/${community.id}/activity`, {
      headers: bearer(stranger.token),
    });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(member.member.id);
    expect(text).not.toContain(member.member.whatsappNumber);
    expect(text).not.toContain("Siti Rahasia");
    expect(text).not.toContain("Kelas Rahasia VIP");
    expect(text).not.toMatch(/[0-9]/);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const res = await a.request(`/communities/${community.id}/activity`);
    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID communityId with 400, not 500", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);
    const res = await a.request("/communities/not-a-uuid/activity", { headers: bearer(token) });
    expect(res.status).toBe(400);
  });

  it("never puts a WhatsApp number in the feed", async () => {
    // The feed is a screen a creator leaves open. Numbers belong only in the export
    // they ask for deliberately.
    const a = app();
    const { token } = await signupAndGetToken(a);
    const community = await makeCommunity(a, token);
    const tier = await makeTier(a, token, community.id, { name: "Basic", priceAmount: 50_000 });
    const member = await seedMemberWithSubscription(tier.id, "active");
    await seedActivity(community.id, "joined", { createdAt: at(1), memberId: member.member.id });

    const text = await (
      await a.request(`/communities/${community.id}/activity`, { headers: bearer(token) })
    ).text();
    expect(text).not.toContain(member.member.whatsappNumber);
  });
});
