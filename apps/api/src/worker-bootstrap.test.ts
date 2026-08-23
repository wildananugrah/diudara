import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import {
  appUsers,
  membershipReminders,
  outbox,
  userSubscriptions,
  userTiers,
} from "./db/schema";
import { resetDatabase } from "./db/test-helpers";
import { FakeEmailAdapter } from "./infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import {
  OUTBOX_GRANT_ACCESS,
  OUTBOX_NOTIFY_JOIN_REQUEST,
  OUTBOX_NOTIFY_STREAM_LIVE,
  OUTBOX_REVOKE_ACCESS,
  OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
  OUTBOX_SEND_RENEWAL_REMINDER,
} from "./application/ports/outbox-repository.port";
import { resolveAppBaseUrl } from "./bootstrap";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { bootstrapWorker } from "./worker-bootstrap";

beforeEach(resetDatabase);

async function rowById(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row;
}

/**
 * The notifier this root selected, narrowed to the fake so its recorded sends can be
 * read. An `instanceof` check rather than a cast: this file forbids casts for the same
 * reason bootstrap.test.ts does, and the check itself is worth making — under
 * `NODE_ENV=test` the fake is what must be selected.
 */
function fakeNotifierOf(worker: ReturnType<typeof bootstrapWorker>): FakeMessagingAdapter {
  const { notifier } = worker.messaging;
  if (!(notifier instanceof FakeMessagingAdapter)) {
    throw new Error("expected the worker to select FakeMessagingAdapter under NODE_ENV=test");
  }
  return notifier;
}

/**
 * The worker has its OWN composition root, separate from `bootstrap()`: it needs
 * no JWT secret, no web base URL and no payment provider, and refusing to start
 * without them would be a deployment hazard for a process that never serves a
 * request.
 *
 * These tests prove the wiring, which nothing else can: Phase 3 shipped a
 * confirmation page that was unreachable for a whole phase because no test
 * checked that an environment variable reached the composition root.
 */
/**
 * An ACTIVE `user_subscription` (Phase 5a/5b's own membership table, nothing to do
 * with `/dashboard/*`'s `subscription`) whose period ends `days` from now — i.e.
 * exactly what `RemindExpiringMembership` warns a member about.
 *
 * The subscriber has a `whatsapp_number`, so both channels are in play; the column is
 * nullable and `remind-expiring-membership.test.ts` covers the other case.
 */
async function seedMembershipEndingInDays(days: number) {
  const [owner] = await db
    .insert(appUsers)
    .values({
      handle: "wildanbw",
      email: "wildanbw@example.com",
      passwordHash: "x",
      displayName: "Wildan",
    })
    .returning();
  const [subscriber] = await db
    .insert(appUsers)
    .values({
      handle: "rinabw",
      email: "rinabw@example.com",
      whatsappNumber: "6281200000000",
      passwordHash: "x",
      displayName: "Rina",
    })
    .returning();
  const [tier] = await db
    .insert(userTiers)
    .values({ ownerId: owner.id, name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" })
    .returning();
  const [subscription] = await db
    .insert(userSubscriptions)
    .values({
      subscriberId: subscriber.id,
      tierId: tier.id,
      ownerId: owner.id,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + days * 86_400_000),
    })
    .returning();
  return { owner, subscriber, tier, subscription };
}

describe("bootstrapWorker", () => {
  /**
   * What this root hands the worker, pinned as an EXACT SET.
   *
   * Retire-telegram Task 4 deleted `ProcessRenewals`, `ProcessChurn` and
   * `SendRenewalReminder` — the community world's dunning cycle — so three fields
   * left this container. Set equality rather than three `toBeUndefined()` checks:
   * an absence check passes just as happily while a fourth, unexpected field
   * survives, and this container is the only place the worker's shape is stated
   * once.
   */
  it("exposes exactly the surviving dependencies", () => {
    expect(Object.keys(bootstrapWorker()).sort()).toEqual([
      "clock",
      "email",
      "messaging",
      "processOutbox",
      "remindExpiringMemberships",
    ]);
  });

  /**
   * Retire-telegram Task 3. `NotifyStreamLive` and the `notify_stream_live`
   * handler registration went with the community broadcast they announced, and
   * with them went this root's ONLY reader of `STREAM_TOKEN_SECRET`.
   *
   * That removed a boot-time refusal, so the removal gets a test of its own: the
   * worker used to throw on a `STREAM_TOKEN_SECRET` shorter than the API's floor,
   * because it would otherwise mint watch tokens the API then rejected. It signs
   * nothing now, so there is nothing left for a weak secret here to corrupt, and
   * refusing to boot over an unused variable would strand every OTHER pass in
   * this process — the renewal reminders, the membership sweeps, the outbox — for
   * a reason that no longer exists.
   *
   * The value is deliberately the same "too-short" one the deleted test asserted
   * `bootstrapWorker` threw on, so this fails if that check is ever reinstated
   * without a reader to justify it.
   */
  it("boots with a too-short STREAM_TOKEN_SECRET — the worker no longer reads it", async () => {
    const original = process.env.STREAM_TOKEN_SECRET;
    process.env.STREAM_TOKEN_SECRET = "too-short";
    try {
      const worker = bootstrapWorker();
      // It booted, and the passes that have nothing to do with streaming are
      // there — which is the whole point of not refusing.
      expect(worker.processOutbox).toBeDefined();
      expect(worker.remindExpiringMemberships).toBeDefined();
    } finally {
      if (original === undefined) delete process.env.STREAM_TOKEN_SECRET;
      else process.env.STREAM_TOKEN_SECRET = original;
    }
  });

  it("wires exactly the event types it knows about, and no more", async () => {
    const repository = new DrizzleOutboxRepository(db);
    const { id } = await repository.enqueue({ eventType: "some_future_event", payload: {} });

    await bootstrapWorker().processOutbox.execute();

    expect((await rowById(id)).lastError).toContain("no handler is registered");
  });

  /**
   * Task 4 of Phase 5b. There is no recurring charge anywhere in this system, so a
   * membership does not renew — it ends, and the member buys again. This pass is the
   * only thing that tells them to, and until it is CONSTRUCTED here it is dead code
   * reachable only from a test: exactly the state Phase 5's Task 7 found
   * `ProcessRenewals` in.
   */
  it("constructs a reminder pass that actually reminds a real expiring membership", async () => {
    const { subscription, subscriber } = await seedMembershipEndingInDays(2);
    const worker = bootstrapWorker();

    const result = await worker.remindExpiringMemberships.execute();

    expect(result.considered).toBe(1);
    expect(result.reminded).toBe(1);
    expect(result.skipped).toBe(0);
    // BOTH channels, because this member has a number on file — and the claim row
    // says so, which is the audit trail an operator reads.
    const [claim] = await db
      .select()
      .from(membershipReminders)
      .where(eq(membershipReminders.userSubscriptionId, subscription.id));
    expect(claim.outcome).toBe("sent");
    expect(claim.channels).toBe("email,whatsapp");
    const email = worker.email;
    expect(email).toBeInstanceOf(FakeEmailAdapter);
    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
    expect((email as FakeEmailAdapter).sent[0].to).toBe(subscriber.email);
    expect(fakeNotifierOf(worker).notifications).toHaveLength(1);
  });

  it("builds the reminder's link from APP_BASE_URL, in THIS root", async () => {
    // The same wiring `send_renewal_reminder` is pinned on above, for the same reason:
    // a hardcoded host would send every member of every deployment to one developer's
    // laptop, and no test on that laptop would notice.
    await seedMembershipEndingInDays(2);
    const worker = bootstrapWorker();

    await worker.remindExpiringMemberships.execute();

    const expected = resolveAppBaseUrl({
      appBaseUrl: process.env.APP_BASE_URL,
      nodeEnv: process.env.NODE_ENV,
    });
    expect((worker.email as FakeEmailAdapter).sent[0].body).toContain(`${expected}/@`);
  });

  it("reminds a lapsing membership exactly once, however many times the loop runs", async () => {
    await seedMembershipEndingInDays(2);
    const worker = bootstrapWorker();

    const first = await worker.remindExpiringMemberships.execute();
    const second = await worker.remindExpiringMemberships.execute();

    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(0);
    expect(second.alreadyReminded).toBe(1);
    expect((worker.email as FakeEmailAdapter).sent).toHaveLength(1);
    expect(fakeNotifierOf(worker).notifications).toHaveLength(1);
  });

  it("re-reminds a membership a MISCONFIGURED BOX skipped, once email is configured", async () => {
    // Review fix round 1, I1, proved end to end against real Postgres and the real
    // repository rather than a fake. `no_channel` describes a deployment with no email
    // provider — every account has an email address — so a worker that ran for an hour
    // without one must not have permanently burned this member's only warning.
    const { subscription } = await seedMembershipEndingInDays(2);
    await db
      .insert(membershipReminders)
      .values({ userSubscriptionId: subscription.id, outcome: "no_channel", channels: null });

    const worker = bootstrapWorker();
    const result = await worker.remindExpiringMemberships.execute();

    expect(result.reminded).toBe(1);
    expect(result.alreadyReminded).toBe(0);
    expect((worker.email as FakeEmailAdapter).sent).toHaveLength(1);
    const [claim] = await db
      .select()
      .from(membershipReminders)
      .where(eq(membershipReminders.userSubscriptionId, subscription.id));
    expect(claim.outcome).toBe("sent");
    // Re-claimed in place: still exactly one row for this membership.
    expect(await db.select().from(membershipReminders)).toHaveLength(1);
  });

  it("does NOT re-remind a membership that was already sent one", async () => {
    // The half that must survive the fix above, also end to end: a member who was told
    // is told once, whatever any later pass does.
    const { subscription } = await seedMembershipEndingInDays(2);
    await db
      .insert(membershipReminders)
      .values({ userSubscriptionId: subscription.id, outcome: "sent", channels: "email" });

    const worker = bootstrapWorker();
    const result = await worker.remindExpiringMemberships.execute();

    expect(result.reminded).toBe(0);
    expect(result.alreadyReminded).toBe(1);
    expect((worker.email as FakeEmailAdapter).sent).toHaveLength(0);
    expect(fakeNotifierOf(worker).notifications).toHaveLength(0);
    // And the record of the original send was not rewritten by the refusal.
    const [claim] = await db
      .select()
      .from(membershipReminders)
      .where(eq(membershipReminders.userSubscriptionId, subscription.id));
    expect(claim.outcome).toBe("sent");
    expect(claim.channels).toBe("email");
  });

  it("refuses to boot on partial email configuration", () => {
    // The worker started reading `RESEND_API_KEY`/`EMAIL_FROM` when Task 4 gave it a
    // reason to send email, so it inherited `selectEmailProvider`'s half-configured
    // guard — a key with no "from" address is a typo, never intentional, and an
    // operator who set one believes email is live. `bootstrap()` has this test; this
    // root did not, so nothing would have caught the guard being removed from the
    // process that actually sends the reminders.
    withEnv({ RESEND_API_KEY: "re_live_x", EMAIL_FROM: undefined }, () => {
      expect(() => bootstrapWorker()).toThrow(/half-configured/);
    });
    withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: "DIUDARA <no-reply@diudara.example>" }, () => {
      expect(() => bootstrapWorker()).toThrow(/half-configured/);
    });
  });

  it("injects the REAL clock into the passes, not a fixture", () => {
    // The passes are the first things in this codebase whose behaviour depends entirely
    // on the current instant, and `FixedClock` exists in this workspace. A root that
    // wired that by accident would leave every member's stage frozen on the day the
    // process booted, and the two tests above are the only other thing that would
    // notice.
    const { clock } = bootstrapWorker();
    expect(clock).toBeInstanceOf(SystemClock);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(60_000);
  });

  /**
   * Retire-telegram Tasks 2, 3 and 4. The SIX event types whose handlers went with
   * the use-cases that served them — four in Task 2 (channel access and join
   * requests), `notify_stream_live` in Task 3 with `NotifyStreamLive`, and
   * `send_renewal_reminder` in Task 4 with `SendRenewalReminder` and the
   * `ProcessRenewals` pass that was its only writer.
   *
   * That sixth entry means the handler map is now EMPTY, so this block is the whole
   * of what `ProcessOutbox` can be asked to dispatch. It replaces two tests Task 4
   * deleted — "dispatches a real send_renewal_reminder row to SendRenewalReminder,
   * not to nothing" and "builds the reminder's checkout link from APP_BASE_URL, in
   * THIS root". The first pinned exactly the registration that has now gone. The
   * second pinned that this root resolves `APP_BASE_URL` at all, and that property
   * did NOT go with it: `RemindExpiringMembership` builds its own link from the same
   * value, and "builds the reminder's link from APP_BASE_URL, in THIS root" above
   * asserts it against the surviving pass.
   *
   * A registration left behind is INVISIBLE from the outside — the worker boots,
   * the pass runs, and the handler simply never fires — so nothing but a row
   * pushed through `ProcessOutbox` can tell the two states apart. `ProcessOutbox`
   * fails an unregistered type with `no handler is registered for outbox event
   * type "..."`, which is the literal this asserts on.
   *
   * These replace the "dispatches a real <type> row to <use-case>" tests that
   * lived here: those pinned exactly the registrations those tasks removed, so
   * they are the guard being deleted and this is its replacement. Task 3 deleted
   * two more of that shape ("dispatches a real notify_stream_live row to
   * NotifyStreamLive" and "does not register a notify_stream_live handler when
   * STREAM_TOKEN_SECRET is unset") and the fifth entry below replaces BOTH — the
   * second of them asserted this exact outcome for one environment, and it is now
   * the outcome in every environment.
   *
   * ONE `it.each` DECLARATION, SIX TEST RUNS.
   */
  it.each([
    OUTBOX_GRANT_ACCESS,
    OUTBOX_REVOKE_ACCESS,
    OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
    OUTBOX_NOTIFY_JOIN_REQUEST,
    OUTBOX_NOTIFY_STREAM_LIVE,
    OUTBOX_SEND_RENEWAL_REMINDER,
  ])("registers no handler for %s any more", async (eventType) => {
    const repository = new DrizzleOutboxRepository(db);
    const { id } = await repository.enqueue({
      eventType,
      payload: { subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666" },
    });

    const result = await bootstrapWorker().processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);
    const row = await rowById(id);
    expect(row.lastError).toContain("no handler is registered");
  });

  it("selects the fake messaging adapter under NODE_ENV=test", () => {
    // `bun test` sets NODE_ENV=test, and the whole suite depends on the fake.
    // Constructing the root at all is the assertion: with the real token absent and
    // a NODE_ENV outside the allowlist, selectMessagingProviders throws.
    //
    // Retire-telegram Task 2 dropped this test's second assertion, on
    // `messaging.gating.get("telegram")` — there is no gating map any more, and the
    // one provider left is the WhatsApp notifier asserted on above.
    const worker = bootstrapWorker();
    expect(worker.messaging.notifier.capabilities().canGateAccess).toBe(false);
  });
});

/**
 * Runs `fn` with `vars` applied to `process.env`, restoring every one of them
 * afterwards — including the ones that were previously unset. Copied from
 * `bootstrap.test.ts` rather than shared: these are two composition roots with two
 * different sets of variables, and a helper imported across them would tie their test
 * files together for four lines of bookkeeping.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
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
    fn();
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
