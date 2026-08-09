import { describe, expect, it, beforeEach } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";
import { bearer, signupAndGetToken } from "./test-support";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
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
});

// The "creator has no email" guard in CreatePaymentAccount is covered at the
// use-case level (create-payment-account.test.ts): /auth/signup requires an
// email (see signupSchema), so there is no way to reach an email-less creator
// through this route in the current phase, and a route test claiming to
// cover that path would not actually exercise it.
