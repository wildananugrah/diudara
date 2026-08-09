import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { outbox } from "./db/schema";
import { resetDatabase } from "./db/test-helpers";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import {
  OUTBOX_GRANT_ACCESS,
  OUTBOX_REVOKE_ACCESS,
} from "./application/ports/outbox-repository.port";
import { bootstrapWorker } from "./worker-bootstrap";

beforeEach(resetDatabase);

async function rowById(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  return row;
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
describe("bootstrapWorker", () => {
  it("dispatches a real grant_access row to GrantChannelAccess, not to nothing", async () => {
    const repository = new DrizzleOutboxRepository(db);
    // A well-formed payload for a subscription that does not exist: it reaches
    // the use-case and fails THERE. The point is which error comes back — an
    // unwired handler would say "no handler is registered", which is the
    // failure mode this test exists to catch.
    const { id } = await repository.enqueue({
      eventType: OUTBOX_GRANT_ACCESS,
      payload: { subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666" },
    });

    const result = await bootstrapWorker().processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);
    const row = await rowById(id);
    expect(row.lastError).toContain("subscription");
    expect(row.lastError).not.toContain("no handler is registered");
  });

  /**
   * I3, final whole-branch review. A failed platform removal now becomes a
   * `revoke_access` row, and this proves the WORKER actually handles it — a row
   * nothing is wired for would fail permanently five attempts later, which is exactly
   * the "no durable, actionable record" state the finding was about.
   */
  it("dispatches a real revoke_access row to the revocation retry, not to nothing", async () => {
    const repository = new DrizzleOutboxRepository(db);
    // A well-formed payload for a membership that does not exist. It reaches the
    // use-case, which reports "nothing outstanding" and COMPLETES — so the row is
    // `sent`. An unwired handler would instead leave "no handler is registered".
    const { id } = await repository.enqueue({
      eventType: OUTBOX_REVOKE_ACCESS,
      payload: {
        membershipId: "3f1c9e0a-1111-4222-8333-444455556666",
        communityId: "3f1c9e0a-1111-4222-8333-444455556667",
        memberId: "3f1c9e0a-1111-4222-8333-444455556668",
      },
    });

    const result = await bootstrapWorker().processOutbox.execute();

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("sent");
    // Null, not an unwired-handler message: it never failed at all.
    expect(row.lastError).toBeNull();
  });

  it("wires exactly the event types it knows about, and no more", async () => {
    const repository = new DrizzleOutboxRepository(db);
    const { id } = await repository.enqueue({ eventType: "some_future_event", payload: {} });

    await bootstrapWorker().processOutbox.execute();

    expect((await rowById(id)).lastError).toContain("no handler is registered");
  });

  it("selects the fake messaging adapters under NODE_ENV=test", () => {
    // `bun test` sets NODE_ENV=test, and the whole suite depends on the fakes.
    // Constructing the root at all is the assertion: with real tokens absent and
    // a NODE_ENV outside the allowlist, selectMessagingProviders throws.
    const worker = bootstrapWorker();
    expect(worker.messaging.notifier.capabilities().canGateAccess).toBe(false);
    expect(worker.messaging.gating.get("telegram")?.capabilities().canGateAccess).toBe(true);
  });
});
