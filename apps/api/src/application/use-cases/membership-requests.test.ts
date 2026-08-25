import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { appUsers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { ConflictError, NotFoundError } from "../errors";
import { DrizzleUserTierRepository } from "../../infrastructure/repositories/drizzle-user-tier.repository";
import { DrizzleUserSubscriptionRepository } from "../../infrastructure/repositories/drizzle-user-subscription.repository";
import { MembershipRequests } from "./membership-requests";

beforeEach(resetDatabase);

const subs = new DrizzleUserSubscriptionRepository(db);
const tiers = new DrizzleUserTierRepository(db);

function buildUseCase() {
  return new MembershipRequests(subs);
}

let seedCounter = 0;

/** Follows `drizzle-user-subscription.repository.test.ts`'s `createUser` shape exactly. */
async function createUser(handle: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seedCounter}`,
      email: `${handle}${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

async function createFreeTier(ownerId: string, name = "Anggota Gratis") {
  return tiers.create({ ownerId, name, priceAmount: 0, billingCycle: "monthly" });
}

/**
 * A fresh PENDING FREE request — the exact shape Task 4's
 * `StartUserSubscription` free path writes via
 * `claimPending({ ..., kind: "free" })`, over a dedicated free tier.
 */
async function seedPendingFreeRequest(subscriberId: string, ownerId: string, tierName = "Anggota Gratis") {
  const tier = await createFreeTier(ownerId, tierName);
  const claim = await subs.claimPending({ subscriberId, tierId: tier.id, ownerId, kind: "free" });
  return { requestId: claim.subscription.id, tierId: tier.id };
}

describe("MembershipRequests", () => {
  describe("list", () => {
    it("returns a pending free request with the CLOSED wire projection: id, subscriberHandle, subscriberDisplayName, tierName, createdAt — nothing else", async () => {
      const alice = await createUser("alice"); // owner
      const bob = await createUser("bob"); // subscriber
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id, "Anggota Gratis");

      const result = await buildUseCase().list(alice.id);

      expect(result.requests.length).toBe(1);
      // Object.keys, not a spot-check — the closed shape is what a leaked
      // internal id or email would slip past a spot-check assertion.
      expect(Object.keys(result.requests[0]!).sort()).toEqual([
        "createdAt",
        "id",
        "subscriberDisplayName",
        "subscriberHandle",
        "tierName",
      ]);
      expect(result.requests[0]).toEqual({
        id: requestId,
        subscriberHandle: bob.handle,
        subscriberDisplayName: bob.displayName,
        tierName: "Anggota Gratis",
        createdAt: expect.any(String),
      });
      // ISO on the wire, never a raw Date — JSON has no date type.
      expect(new Date(result.requests[0]!.createdAt).toISOString()).toBe(
        result.requests[0]!.createdAt
      );
    });

    it("excludes another owner's pending requests", async () => {
      const alice = await createUser("alice");
      const carol = await createUser("carol");
      const bob = await createUser("bob");
      await seedPendingFreeRequest(bob.id, carol.id);

      const result = await buildUseCase().list(alice.id);

      expect(result.requests).toEqual([]);
    });

    it("excludes an already-approved (active) membership — it is no longer pending", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      await subs.approveFreeRequest(requestId, alice.id);

      const result = await buildUseCase().list(alice.id);

      expect(result.requests).toEqual([]);
    });

    it("excludes a PAID pending checkout — this queue is free requests only", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const paidTier = await tiers.create({
        ownerId: alice.id,
        name: "Anggota Bulanan",
        priceAmount: 50_000,
        billingCycle: "monthly",
      });
      await subs.claimPending({ subscriberId: bob.id, tierId: paidTier.id, ownerId: alice.id });

      const result = await buildUseCase().list(alice.id);

      expect(result.requests).toEqual([]);
    });

    it("orders oldest first", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const carol = await createUser("carol");
      const first = await seedPendingFreeRequest(bob.id, alice.id, "Tier A");
      const second = await seedPendingFreeRequest(carol.id, alice.id, "Tier B");

      const result = await buildUseCase().list(alice.id);

      expect(result.requests.map((r) => r.id)).toEqual([first.requestId, second.requestId]);
    });
  });

  describe("approve", () => {
    it("approving a pending free request activates it with no period", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();
      const ownerId = alice.id;

      const row = await requests.approve({ ownerId, requestId });

      expect([row.status, row.kind, row.currentPeriodEnd]).toEqual(["active", "free", null]);
    });

    it("a second approval of the same request changes nothing", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();
      const ownerId = alice.id;

      await requests.approve({ ownerId, requestId });

      await expect(requests.approve({ ownerId, requestId })).rejects.toThrow(NotFoundError);
      // Nothing about the now-active row moved as a side effect of the refusal.
      const row = await subs.findById(requestId);
      expect(row?.status).toBe("active");
    });

    /**
     * THE case this whole design exists to get right (see the port's own
     * docstring on `approveFreeRequest`). Two callers race the SAME
     * conditional UPDATE against the SAME row at the real database — no
     * mock, no fake, no serialised `await` between them. Exactly one must
     * win; the other must lose CLEANLY (a `NotFoundError`, not a 500).
     */
    it("CONCURRENT approvals produce exactly one active row", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();
      const ownerId = alice.id;

      const results = await Promise.allSettled([
        requests.approve({ ownerId, requestId }),
        requests.approve({ ownerId, requestId }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      // And the loser failed cleanly — a NotFoundError, never a raw 500.
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(NotFoundError);
      // Exactly one row now sits active for the pair — proven against the
      // real table, not inferred from the settle counts alone.
      const row = await subs.findById(requestId);
      expect(row?.status).toBe("active");
    });

    /**
     * `user_subscription_one_active` refusing the write — meaningless
     * against an in-memory fake, which carries no unique index at all.
     * Bob already holds an ACTIVE row for (bob, alice) via a SEPARATE tier;
     * approving the pending FREE request would create a second active row
     * for the identical pair, which the database refuses.
     */
    it("cannot approve someone who already has an active membership — a clean ConflictError, not a raw driver error", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const paidTier = await tiers.create({
        ownerId: alice.id,
        name: "Anggota Bulanan",
        priceAmount: 50_000,
        billingCycle: "monthly",
      });
      const activeRow = await subs.create({ subscriberId: bob.id, tierId: paidTier.id, ownerId: alice.id });
      await subs.activate(activeRow.id, new Date("2099-01-01T00:00:00.000Z"));
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();
      const ownerId = alice.id;

      // Proven, not assumed: `rejects.toThrow(ConflictError)` fails outright
      // if the repository ever let a raw `DrizzleQueryError`/`PostgresError`
      // escape instead of translating it.
      await expect(requests.approve({ ownerId, requestId })).rejects.toThrow(ConflictError);

      // The refused write left the pending request exactly as it was.
      const stillPending = await subs.findById(requestId);
      expect(stillPending?.status).toBe("pending");
    });

    it("another owner cannot approve a request that is not theirs", async () => {
      const alice = await createUser("alice");
      const stranger = await createUser("stranger");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();

      await expect(
        requests.approve({ ownerId: stranger.id, requestId })
      ).rejects.toThrow(NotFoundError);

      const stillPending = await subs.findById(requestId);
      expect(stillPending?.status).toBe("pending");
    });

    it("a missing request id answers the SAME NotFoundError as a foreign owner's attempt", async () => {
      const alice = await createUser("alice");
      const requests = buildUseCase();

      await expect(
        requests.approve({
          ownerId: alice.id,
          requestId: "00000000-0000-0000-0000-000000000000",
        })
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("reject", () => {
    it("rejecting deletes the row, so the same person may ask again", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();

      await requests.reject({ ownerId: alice.id, requestId });

      expect(await subs.findById(requestId)).toBeNull();
    });

    it("the person may submit a fresh request after rejection — user_subscription_one_pending no longer blocks them", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId, tierId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();
      await requests.reject({ ownerId: alice.id, requestId });

      const claim = await subs.claimPending({
        subscriberId: bob.id,
        tierId,
        ownerId: alice.id,
        kind: "free",
      });

      expect(claim.created).toBe(true);
    });

    it("another owner cannot reject a request that is not theirs", async () => {
      const alice = await createUser("alice");
      const stranger = await createUser("stranger");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();

      await expect(
        requests.reject({ ownerId: stranger.id, requestId })
      ).rejects.toThrow(NotFoundError);

      const stillPending = await subs.findById(requestId);
      expect(stillPending?.status).toBe("pending");
    });

    it("rejecting an already-approved request throws NotFoundError and leaves the active row untouched", async () => {
      const alice = await createUser("alice");
      const bob = await createUser("bob");
      const { requestId } = await seedPendingFreeRequest(bob.id, alice.id);
      const requests = buildUseCase();
      await requests.approve({ ownerId: alice.id, requestId });

      await expect(
        requests.reject({ ownerId: alice.id, requestId })
      ).rejects.toThrow(NotFoundError);

      const row = await subs.findById(requestId);
      expect(row?.status).toBe("active");
    });
  });
});
