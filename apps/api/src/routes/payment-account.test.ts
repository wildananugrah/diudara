import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import type { FakePaymentAdapter } from "../infrastructure/payments/fake-payment.adapter";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

describe("GET /payment-account", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await app().request("/payment-account");
    expect(res.status).toBe(401);
  });

  it("reports not connected and not provisioning for a fresh creator", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/payment-account", { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, provisioning: false, available: true });
  });

  // Setting up "connected"/"provisioning" state WITHOUT calling POST
  // /payment-account: that route calls the (fake, but real-shaped) payment
  // provider and the brief forbids probing it in tests, since the real Xendit
  // adapter's equivalent call provisions a KYC entity with no delete endpoint.
  // Instead this writes the creator row directly through
  // CreatorRepositoryPort, the same two methods CreatePaymentAccount itself
  // uses to claim and fill the column — no HTTP call, no provider call.
  it("reports provisioning while a connection is claimed but not finished", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, creatorId } = await signupAndGetToken(a);
    await deps.creatorRepository.beginXenditAccountProvisioning(creatorId);

    const res = await a.request("/payment-account", { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, provisioning: true, available: true });
  });

  it("reports connected once the column holds a real account id", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, creatorId } = await signupAndGetToken(a);
    await deps.creatorRepository.beginXenditAccountProvisioning(creatorId);
    await deps.creatorRepository.finishXenditAccountProvisioning(creatorId, "xnd-acct-test");

    const res = await a.request("/payment-account", { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, provisioning: false, available: true });
  });

  it("keeps each creator's status independent of another creator's", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const owner = await signupAndGetToken(a);
    const stranger = await signupAndGetToken(a);
    await deps.creatorRepository.beginXenditAccountProvisioning(owner.creatorId);
    await deps.creatorRepository.finishXenditAccountProvisioning(owner.creatorId, "xnd-acct-owner");

    const ownerRes = await a.request("/payment-account", { headers: bearer(owner.token) });
    const strangerRes = await a.request("/payment-account", { headers: bearer(stranger.token) });

    expect(await ownerRes.json()).toEqual({ connected: true, provisioning: false, available: true });
    expect(await strangerRes.json()).toEqual({ connected: false, provisioning: false, available: true });
  });
});

/**
 * The gate's CRITICAL 1. `connected: false, provisioning: false` used to mean
 * two different things — "this server takes payments, you have not connected"
 * and "this server has no payment provider at all" — and the dashboard could
 * not tell them apart. It therefore offered a "berbayar" community on a box
 * where `CreateCommunity` refuses one, i.e. a form that can only ever 409.
 */
describe("GET /payment-account, payments disabled on the server", () => {
  it("reports available: false, distinguishing 'not configured here' from 'not connected yet'", async () => {
    const seedApp = app();
    const { token } = await signupAndGetToken(seedApp);

    // Same creator, same column, same two booleans — only `available` moves.
    expect(await (await seedApp.request("/payment-account", { headers: bearer(token) })).json())
      .toEqual({ connected: false, provisioning: false, available: true });

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
        // Task 2 (images): selectMediaStorage now block-boots NODE_ENV=production
        // with no S3 vars set — fully configured here so this test stays isolated
        // to the payments dimension, same reasoning as the messaging tokens above.
        S3_ACCESS_KEY_ID: "test-s3-access-key",
        S3_SECRET_ACCESS_KEY: "test-s3-secret-key",
        S3_BUCKET: "test-bucket",
        S3_ENDPOINT: "https://s3.test.example.com",
        S3_REGION: "id-jkt-1",
      },
      async () => {
        const disabledApp = createApp(bootstrap());
        const res = await disabledApp.request("/payment-account", { headers: bearer(token) });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          connected: false,
          provisioning: false,
          available: false,
        });

        // And it agrees with the POST's own 503 on the same box — one signal.
        const post = await disabledApp.request("/payment-account", {
          method: "POST",
          headers: bearer(token),
        });
        expect(post.status).toBe(503);
      }
    );
  });
});

/** Swaps env vars for one async block and restores them, exactly as
    `public-community.test.ts`'s own copy does. */
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

describe("POST /payment-account", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const a = app();

    const res = await a.request("/payment-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(401);
  });

  it("connects a payment account on first call and never returns passwordHash", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const res = await a.request("/payment-account", {
      method: "POST",
      headers: bearer(token),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.xenditAccountId).toBeTruthy();
    expect("passwordHash" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("returns 409 on a second call rather than creating a duplicate account", async () => {
    const a = app();
    const { token } = await signupAndGetToken(a);

    const first = await a.request("/payment-account", {
      method: "POST",
      headers: bearer(token),
    });
    expect(first.status).toBe(201);

    const second = await a.request("/payment-account", {
      method: "POST",
      headers: bearer(token),
    });

    expect(second.status).toBe(409);
    const body = await second.json();
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  /**
   * I4, final whole-branch review — the wired version of the probe. Before the
   * conditional UPDATE, 5 concurrent requests with ONE bearer token returned
   * 201 five times in 3 of 3 rounds and the winner was nondeterministic, so the
   * creator's `xendit_account_id` named whichever provider account happened to
   * write last while four other callers had been told they were connected.
   *
   * The one 201's body must name the id that is actually IN the column: that is
   * what "connected" means, and it is the assertion the unconditional UPDATE
   * cannot satisfy.
   */
  it("lets exactly one of 5 concurrent requests connect the account", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token, creatorId } = await signupAndGetToken(a);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        a.request("/payment-account", { method: "POST", headers: bearer(token) })
      )
    );

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);

    // The 201's body must name the id that is actually IN the column. Under the
    // unconditional UPDATE all five said 201 and four of those bodies named an
    // account the creator's row does not reference.
    const winner = responses.find((r) => r.status === 201)!;
    const { xenditAccountId } = await winner.json();
    expect(xenditAccountId).toBeTruthy();
    expect((await deps.creatorRepository.findById(creatorId))?.xenditAccountId).toBe(
      xenditAccountId
    );
  });

  /**
   * Task 7 item 1 — the half of the concurrency probe the Phase 3 fix left open.
   *
   * The DB TOCTOU is closed (the test above), but the PROVIDER CALL still came
   * first, so every losing request created a sub-account before finding out it
   * had lost. Measured on this branch before the fix: 30 concurrent requests →
   * 30 Xendit sub-accounts, 29 of them orphaned; sequentially → 1. Xendit MANAGED
   * sub-accounts are KYC entities with no delete endpoint, so each orphan is
   * permanent and reconcilable only by hand.
   *
   * The row-count assertion above cannot see this: the column holds one id either
   * way. Only the count of PROVIDER calls can.
   */
  it("mints exactly ONE provider sub-account under 5 concurrent requests", async () => {
    const deps = bootstrap();
    const a = createApp(deps);
    const { token } = await signupAndGetToken(a);
    // NODE_ENV=test, so selectPaymentProvider returned the fake — which records
    // every account it was asked to create. That array is the whole assertion.
    const payments = deps.payments as FakePaymentAdapter;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        a.request("/payment-account", { method: "POST", headers: bearer(token) })
      )
    );

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(payments.accounts).toHaveLength(1);
  });
});

// The "creator has no email" guard in CreatePaymentAccount is covered at the
// use-case level (create-payment-account.test.ts): /auth/signup requires an
// email (see signupSchema), so there is no way to reach an email-less creator
// through this route in the current phase, and a route test claiming to
// cover that path would not actually exercise it.
