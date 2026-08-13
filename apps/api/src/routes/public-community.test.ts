import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function seedCommunity(a: ReturnType<typeof app>) {
  const { token } = await signupAndGetToken(a);
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
  return { token, community, tier };
}

describe("GET /c/:slug", () => {
  it("returns the community and its active tiers without authentication", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const res = await a.request(`/c/${community.slug}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("Kelas Bimbel Budi");
    expect(body.tiers.length).toBe(1);
    expect(body.tiers[0].priceAmount).toBe(50000);
  });

  it("leaks nothing about the creator or the platform's payment wiring", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const text = await (await a.request(`/c/${community.slug}`)).text();
    for (const forbidden of ["creatorId", "creator_id", "xendit", "passwordHash", "email"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("hides inactive tiers from buyers", async () => {
    const a = app();
    const { token, community, tier } = await seedCommunity(a);
    await a.request(`/communities/${community.id}/tiers/${tier.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ isActive: false }),
    });

    const body = await (await a.request(`/c/${community.slug}`)).json();
    expect(body.tiers.length).toBe(0);
  });

  it("marks an active community as accepting new members", async () => {
    const a = app();
    const { community } = await seedCommunity(a);

    const body = await (await a.request(`/c/${community.slug}`)).json();
    expect(body.acceptingNewMembers).toBe(true);
  });

  // Spec §9.1: a creator pausing for a holiday keeps every checkout link they
  // have already broadcast into WhatsApp working. Before this, `paused`
  // collapsed into `archived` and the page 404'd.
  it("still renders a paused community, flagged as closed to new members", async () => {
    const a = app();
    const { token, community } = await seedCommunity(a);
    await a.request(`/communities/${community.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ status: "paused" }),
    });

    const res = await a.request(`/c/${community.slug}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("Kelas Bimbel Budi");
    expect(body.acceptingNewMembers).toBe(false);
  });

  it("returns 404 for an unknown slug", async () => {
    expect((await app().request("/c/tidak-ada")).status).toBe(404);
  });

  it("returns 404 for an archived community", async () => {
    const a = app();
    const { token, community } = await seedCommunity(a);
    await a.request(`/communities/${community.id}`, {
      method: "PATCH",
      headers: bearer(token),
      body: JSON.stringify({ status: "archived" }),
    });

    expect((await a.request(`/c/${community.slug}`)).status).toBe(404);
  });
});

/**
 * Runs `fn` with each of `vars` set to its given value (or unset when the
 * value is `undefined`), always restoring the originals — the same
 * in-process mutation `bootstrap.test.ts`'s own `withEnv` uses, and for the
 * same reason: Bun auto-loads `apps/api/.env`, so mutating `process.env`
 * in-process (rather than via the shell) is what a call to `bootstrap()`
 * made inside `fn` actually sees.
 *
 * ASYNC, unlike `bootstrap.test.ts`'s version: `fn` here makes real HTTP
 * requests against the app it builds, so the restore in `finally` must wait
 * for `fn`'s returned promise — restoring synchronously (as a bare `fn()`
 * would) lets `finally` run before those awaited requests resolve, since an
 * async function only runs synchronously up to its first `await`.
 */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("POST /c/:slug/checkout, payments disabled", () => {
  // Task 2 (free communities): with no Xendit configuration and NODE_ENV
  // outside RELAXED_NODE_ENVS, `selectPaymentProvider` returns `null`,
  // `bootstrap()` never constructs `StartCheckout`, and
  // `publicCommunityRoutes` never registers this route at all — so a request
  // to it 404s through Hono's ordinary not-found path, exactly like a path
  // this app never mounted. Not a fake invoice, not a 500, not a stub that
  // throws when called.
  //
  // Messaging is fully configured in the `withEnv` override below —
  // `selectMessagingProviders` still throws outside the allowlist when
  // absent (unaffected by this task), and this test needs `bootstrap()` to
  // succeed so it can prove the CHECKOUT route specifically is the one
  // that's gone, not that the whole process failed to boot.
  it("404s instead of registering the route", async () => {
    // Seeded through the NORMAL (payments-enabled, NODE_ENV=test) app —
    // creating a community does not depend on the payment provider.
    const seedApp = app();
    const { community, tier } = await seedCommunity(seedApp);

    await withEnv(
      {
        NODE_ENV: "production",
        APP_BASE_URL: "http://localhost:5173",
        XENDIT_SECRET_KEY: undefined,
        XENDIT_SPLIT_RULE_ID: undefined,
        XENDIT_CALLBACK_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN: "123456:real-bot-token",
        FONNTE_API_TOKEN: "real-fonnte-token",
        TELEGRAM_WEBHOOK_SECRET: "tg_" + "S".repeat(40),
      },
      async () => {
        const disabledApp = createApp(bootstrap());
        const res = await disabledApp.request(`/c/${community.slug}/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tierId: tier.id,
            payerName: "Budi",
            payerWhatsappNumber: "+6281234567890",
          }),
        });
        expect(res.status).toBe(404);

        // GET /c/:slug itself must still work — only the checkout route is gone.
        const getRes = await disabledApp.request(`/c/${community.slug}`);
        expect(getRes.status).toBe(200);
      }
    );
  });
});
