import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { events, subscriptions, transactions } from "../db/schema";
import { verifyWatchToken } from "../domain/watch-token";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

const TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";

function app() {
  return createApp(bootstrap());
}

/** Runs a real checkout and returns the ids the status endpoint and webhook reference. */
async function checkout(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
  await a.request("/payment-account", { method: "POST", headers: bearer(token) });

  const community = await (
    await a.request("/communities", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Kelas Bimbel Budi", niche: "bimbel" }),
    })
  ).json();
  const tier = await (
    await a.request(`/communities/${community.id}/tiers`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ name: "Basic", priceAmount: 50000, billingCycle: "monthly" }),
    })
  ).json();
  const result = await (
    await a.request(`/c/${community.slug}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierId: tier.id,
        payerName: "Siti Marlina",
        payerWhatsappNumber: "+6281234567890",
      }),
    })
  ).json();

  // The webhook now verifies `body.id` against the invoice id StartCheckout
  // recorded, so a test delivery has to echo back the real one rather than an
  // invented "evt-1". Read from the column, not from the fake adapter, because
  // that is what the handler compares against.
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, result.transactionId));

  return {
    subscriptionId: result.subscriptionId as string,
    externalId: result.transactionId as string,
    invoiceId: tx.gatewayReferenceId!,
    communityId: community.id as string,
  };
}

/**
 * All four streaming env vars, restored afterwards — the same pattern
 * `mediamtx-webhooks.test.ts`'s own end-to-end tests use to exercise the
 * REAL `bootstrap()` with streaming enabled, rather than a hand-built
 * `deps` object. `selectStreamingProvider` throws on anything less than
 * all four, so `getSubscriptionStatus`'s `watchUrl` field cannot be
 * observed through the real app without all four present.
 */
async function withStreamingConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const STREAM_SECRET = "d".repeat(32);
  const originals = {
    MEDIAMTX_RTMP_HOST: process.env.MEDIAMTX_RTMP_HOST,
    MEDIAMTX_HLS_BASE_URL: process.env.MEDIAMTX_HLS_BASE_URL,
    MEDIAMTX_WEBHOOK_SECRET: process.env.MEDIAMTX_WEBHOOK_SECRET,
    STREAM_TOKEN_SECRET: process.env.STREAM_TOKEN_SECRET,
  };
  process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
  process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
  process.env.MEDIAMTX_WEBHOOK_SECRET = STREAM_SECRET;
  process.env.STREAM_TOKEN_SECRET = STREAM_SECRET;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

let seedCounter = 0;

/** One event in `communityId`, at the given `status`, with a fresh stream key. */
async function seedEvent(communityId: string, status: string) {
  seedCounter += 1;
  const streamKey = `status-key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey,
      status,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${streamKey}/index.m3u8`,
    })
    .returning();
  return event!;
}

function postWebhook(a: ReturnType<typeof app>, externalId: string, invoiceId: string) {
  return a.request("/webhooks/xendit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CALLBACK-TOKEN": TOKEN },
    body: JSON.stringify({ id: invoiceId, external_id: externalId, status: "PAID", amount: 50000 }),
  });
}

describe("GET /c/subscription/:subscriptionId/status", () => {
  it("returns pending for a freshly created subscription, without authentication", async () => {
    const a = app();
    const { subscriptionId } = await checkout(a);

    const res = await a.request(`/c/subscription/${subscriptionId}/status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("pending");
  });

  it("flips to active once the webhook activates the subscription", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);

    expect((await postWebhook(a, externalId, invoiceId)).status).toBe(200);

    const body = await (await a.request(`/c/subscription/${subscriptionId}/status`)).json();
    expect(body.status).toBe("active");
  });

  it("returns 404 for an unknown (but well-formed) subscription id", async () => {
    const res = await app().request(
      "/c/subscription/00000000-0000-0000-0000-000000000000/status"
    );
    expect(res.status).toBe(404);
  });

  it("404s a subscription id that is not even a uuid, rather than 500ing", async () => {
    const a = app();
    for (const bad of ["haxx", "1 OR 1=1", "0000", "../../etc/passwd"]) {
      expect((await a.request(`/c/subscription/${encodeURIComponent(bad)}/status`)).status).toBe(
        404
      );
    }
  });

  // THE central risk of this endpoint: the id travels in a redirect URL, may
  // sit in browser history, and could be guessed at. It must return ONLY the
  // status string — asserted against the RAW response text, not a typed
  // field, because a spread would leak a column silently and a
  // `body.someField === undefined` check would not catch that.
  it("leaks nothing but the status — no name, WhatsApp number, amount, tier, creator, or community", async () => {
    const a = app();
    const { subscriptionId } = await checkout(a);

    const res = await a.request(`/c/subscription/${subscriptionId}/status`);
    const text = await res.text();

    expect(text).toBe(JSON.stringify({ status: "pending" }));

    for (const forbidden of [
      "Siti",
      "Marlina",
      "6281234567890",
      "50000",
      "Basic",
      "Bimbel",
      "memberId",
      "member_id",
      "tierId",
      "tier_id",
      "creatorId",
      "creator_id",
      "communityId",
      "community_id",
      "whatsapp",
      "xendit",
      "passwordHash",
      "email",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("leaks nothing even once active — same projection after activation", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId } = await checkout(a);
    await postWebhook(a, externalId, invoiceId);

    const text = await (await a.request(`/c/subscription/${subscriptionId}/status`)).text();
    expect(text).toBe(JSON.stringify({ status: "active" }));
  });
});

describe("GET /c/subscription/:subscriptionId/status — the watchUrl field (Task 8)", () => {
  it("carries no watchUrl at all while streaming is not configured on this box", async () => {
    const a = app();
    const { subscriptionId, externalId, invoiceId, communityId } = await checkout(a);
    await postWebhook(a, externalId, invoiceId);
    await seedEvent(communityId, "live");

    const text = await (await a.request(`/c/subscription/${subscriptionId}/status`)).text();

    // Byte-identical to the pre-Task-8 shape: streaming being off must not
    // change this endpoint's response even when the member's community IS
    // live, because there is nothing to mint a token WITH.
    expect(text).toBe(JSON.stringify({ status: "active" }));
  });

  it("adds a watchUrl once the member's community goes live, and it resolves through the read-auth path for real", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId, communityId } = await checkout(a);
      await postWebhook(a, externalId, invoiceId);
      await seedEvent(communityId, "live");

      const body = await (await a.request(`/c/subscription/${subscriptionId}/status`)).json();

      expect(typeof body.watchUrl).toBe("string");
      expect(body.watchUrl.startsWith("/watch/")).toBe(true);

      // Proves the minted token is not merely well-shaped, but genuinely
      // authorises a read: it resolves through the SAME public route
      // WatchPage will call.
      const token = body.watchUrl.slice("/watch/".length);
      const resolved = await (await a.request(`/c/watch/${token}`)).json();
      expect(typeof resolved.hlsUrl).toBe("string");
    });
  });

  it("omits watchUrl when streaming is configured but the community has nothing live", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId } = await checkout(a);
      await postWebhook(a, externalId, invoiceId);

      const text = await (await a.request(`/c/subscription/${subscriptionId}/status`)).text();

      expect(text).toBe(JSON.stringify({ status: "active" }));
    });
  });

  it("omits watchUrl for a pending subscription, even with a live event in its community", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const { subscriptionId, communityId } = await checkout(a);
      await seedEvent(communityId, "live");

      const text = await (await a.request(`/c/subscription/${subscriptionId}/status`)).text();

      expect(text).toBe(JSON.stringify({ status: "pending" }));
    });
  });

  it("mints a FRESH token on every visit, rather than reusing one", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId, communityId } = await checkout(a);
      await postWebhook(a, externalId, invoiceId);
      await seedEvent(communityId, "live");

      const first = await (await a.request(`/c/subscription/${subscriptionId}/status`)).json();
      const second = await (await a.request(`/c/subscription/${subscriptionId}/status`)).json();

      expect(first.watchUrl).not.toBe(second.watchUrl);
    });
  });

  it("stops appearing once the subscription is cancelled, even though the community is still live", async () => {
    await withStreamingConfigured(async () => {
      const a = app();
      const { subscriptionId, externalId, invoiceId, communityId } = await checkout(a);
      await postWebhook(a, externalId, invoiceId);
      await seedEvent(communityId, "live");
      await db
        .update(subscriptions)
        .set({ status: "cancelled" })
        .where(eq(subscriptions.id, subscriptionId));

      const text = await (await a.request(`/c/subscription/${subscriptionId}/status`)).text();

      expect(text).toBe(JSON.stringify({ status: "cancelled" }));
    });
  });
});
