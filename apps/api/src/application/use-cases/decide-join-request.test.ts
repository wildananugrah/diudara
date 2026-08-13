import { describe, expect, it } from "bun:test";
import { DecideJoinRequest, ListJoinRequests } from "./decide-join-request";
import { ConflictError, NotFoundError, UniqueRule, UniqueViolationError } from "../errors";
import { OUTBOX_GRANT_ACCESS } from "../ports/outbox-repository.port";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  MembershipTierRepositoryPort,
  TierRecord,
} from "../ports/membership-tier-repository.port";
import type {
  SubscriptionRecord,
  SubscriptionRepositoryPort,
} from "../ports/subscription-repository.port";
import type {
  JoinRequestRecord,
  JoinRequestRepositoryPort,
  PendingJoinRequestRow,
} from "../ports/join-request-repository.port";
import type {
  JoinRequestRepositories,
  JoinRequestUnitOfWorkPort,
} from "../ports/join-request-unit-of-work.port";

function community(overrides: Partial<CommunityRecord> = {}): CommunityRecord {
  return {
    id: "community-1",
    creatorId: "creator-1",
    name: "Kelas Rina",
    slug: "kelas-rina",
    niche: null,
    status: "active",
    accessMode: "request",
    createdAt: new Date(0),
    ...overrides,
  };
}

function tier(overrides: Partial<TierRecord> = {}): TierRecord {
  return {
    id: "tier-1",
    communityId: "community-1",
    name: "Gratis",
    priceAmount: 0,
    billingCycle: "monthly",
    isActive: true,
    ...overrides,
  };
}

function joinRequestRecord(overrides: Partial<JoinRequestRecord> = {}): JoinRequestRecord {
  return {
    id: "request-1",
    communityId: "community-1",
    tierId: "tier-1",
    memberId: "member-1",
    status: "pending",
    createdAt: new Date(0),
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

function subscriptionRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: "subscription-1",
    memberId: "member-1",
    tierId: "tier-1",
    status: "active",
    nextBillingDate: null,
    graceEndsAt: null,
    startedAt: new Date(0),
    retryCount: 0,
    lastAttemptAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function unusedSubscriptions(): SubscriptionRepositoryPort {
  return {
    async createPending() {
      throw new Error("not used in these tests");
    },
    async createActiveWithoutBilling() {
      throw new Error("not used in these tests");
    },
    async findCurrentSubscriptionForTier() {
      throw new Error("not used in these tests");
    },
    async findById() {
      throw new Error("not used in these tests");
    },
    async findByIdWithCommunity() {
      throw new Error("not used in these tests");
    },
    async createTransaction() {
      throw new Error("not used in these tests");
    },
    async findTransactionByExternalId() {
      throw new Error("not used in these tests");
    },
    async attachGatewayReference() {
      throw new Error("not used in these tests");
    },
    async markPaid() {
      throw new Error("not used in these tests");
    },
    async findDueForRenewal() {
      throw new Error("not used in these tests");
    },
    async markPastDue() {
      throw new Error("not used in these tests");
    },
    async findPastGraceDeadline() {
      throw new Error("not used in these tests");
    },
    async markChurned() {
      throw new Error("not used in these tests");
    },
    async hasLiveSubscriptionInCommunity() {
      throw new Error("not used in these tests");
    },
    async findRenewalContext() {
      throw new Error("not used in these tests");
    },
    async listActiveForCommunity() {
      throw new Error("not used in these tests");
    },
  };
}

/**
 * Mirrors `FakeJoinRequestUnitOfWork` in request-to-join.test.ts exactly: runs
 * `work` against the fakes it was built with, and counts calls so a test can pin
 * atomicity (exactly one unit of work per decision) at the call-site.
 */
class FakeJoinRequestUnitOfWork implements JoinRequestUnitOfWorkPort {
  runCallCount = 0;

  constructor(private readonly repositories: JoinRequestRepositories) {}

  async run<T>(work: (repositories: JoinRequestRepositories) => Promise<T>): Promise<T> {
    this.runCallCount += 1;
    return work(this.repositories);
  }
}

/**
 * A minimal `DecideJoinRequest` wired to fake ports, one knob per refusal and
 * per branch this use-case has to apply.
 *
 * TWO separate `SubscriptionRepositoryPort` fakes are involved on purpose,
 * mirroring the real wiring: `precheckExisting` backs the POOLED port (the
 * graceful pre-check, read before any transaction opens) and
 * `createActiveWithoutBillingImpl` backs the TRANSACTION-BOUND port (the
 * actual write, and the constraint catch's backstop). A test that wants to
 * prove the backstop — not the pre-check — sets the pre-check to find nothing
 * while the in-transaction create still throws.
 */
function harness(
  options: {
    community?: Partial<CommunityRecord> | null;
    request?: Partial<JoinRequestRecord> | null;
    tiers?: TierRecord[];
    precheckExisting?: SubscriptionRecord | null;
    decideResults?: boolean[];
    createActiveWithoutBillingImpl?: (input: {
      memberId: string;
      tierId: string;
    }) => Promise<SubscriptionRecord>;
  } = {}
) {
  const findByIdForCreatorCalls: { id: string; creatorId: string }[] = [];
  const findByIdCalls: string[] = [];
  const decideCalls: { id: string; status: string; decidedBy: string }[] = [];
  const createActiveWithoutBillingCalls: { memberId: string; tierId: string }[] = [];
  const precheckCalls: { memberId: string; tierId: string }[] = [];
  const outboxCalls: { eventType: string; payload: unknown }[] = [];
  const activityLogCalls: {
    memberId: string | null;
    communityId: string;
    eventType: string;
    metadata?: unknown;
  }[] = [];

  let decideCallIndex = 0;
  const decideResults = options.decideResults ?? [true];

  const communities: CommunityRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByIdForCreator(id, creatorId) {
      findByIdForCreatorCalls.push({ id, creatorId });
      if (options.community === null) return null;
      return community({ id, ...options.community });
    },
    async listByCreator() {
      throw new Error("not used in these tests");
    },
    async slugExists() {
      throw new Error("not used in these tests");
    },
    async update() {
      throw new Error("not used in these tests");
    },
    async findBySlug() {
      throw new Error("not used in these tests");
    },
  };

  const tiers: MembershipTierRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async listByCommunity() {
      return options.tiers ?? [tier()];
    },
    async updateForCommunity() {
      throw new Error("not used in these tests");
    },
  };

  const joinRequests: JoinRequestRepositoryPort = {
    async createPending() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      findByIdCalls.push(id);
      if (options.request === null) return null;
      return joinRequestRecord(options.request);
    },
    async listPendingForCommunity() {
      throw new Error("not used in these tests");
    },
    async decide(input) {
      decideCalls.push({ id: input.id, status: input.status, decidedBy: input.decidedBy });
      const result = decideResults[decideCallIndex] ?? decideResults[decideResults.length - 1];
      decideCallIndex += 1;
      return result;
    },
  };

  const precheckSubscriptions: SubscriptionRepositoryPort = {
    ...unusedSubscriptions(),
    async findCurrentSubscriptionForTier(memberId, tierId) {
      precheckCalls.push({ memberId, tierId });
      return options.precheckExisting ?? null;
    },
  };

  const transactionalSubscriptions: SubscriptionRepositoryPort = {
    ...unusedSubscriptions(),
    async createActiveWithoutBilling(input) {
      createActiveWithoutBillingCalls.push(input);
      if (options.createActiveWithoutBillingImpl) {
        return options.createActiveWithoutBillingImpl(input);
      }
      return subscriptionRecord({ memberId: input.memberId, tierId: input.tierId });
    },
  };

  const unitOfWork = new FakeJoinRequestUnitOfWork({
    joinRequests,
    subscriptions: transactionalSubscriptions,
    outbox: {
      async enqueue(input) {
        outboxCalls.push(input);
        return { id: "outbox-1" };
      },
      async enqueueMany() {
        throw new Error("not used in these tests");
      },
      async claimBatch() {
        throw new Error("not used in these tests");
      },
      async touchProcessing() {
        throw new Error("not used in these tests");
      },
      async releaseToPending() {
        throw new Error("not used in these tests");
      },
      async markSent() {
        throw new Error("not used in these tests");
      },
      async markFailed() {
        throw new Error("not used in these tests");
      },
      async markPermanentlyFailed() {
        throw new Error("not used in these tests");
      },
      async reclaimStaleProcessing() {
        throw new Error("not used in these tests");
      },
    },
    activityLog: {
      async record(input) {
        activityLogCalls.push(input);
      },
    },
  });

  const decideJoinRequest = new DecideJoinRequest(
    communities,
    tiers,
    joinRequests,
    precheckSubscriptions,
    unitOfWork
  );
  const listJoinRequests = new ListJoinRequests(communities, joinRequests);

  return {
    decideJoinRequest,
    listJoinRequests,
    findByIdForCreatorCalls,
    findByIdCalls,
    decideCalls,
    createActiveWithoutBillingCalls,
    precheckCalls,
    outboxCalls,
    activityLogCalls,
    unitOfWork,
  };
}

const INPUT = {
  creatorId: "creator-1",
  communityId: "community-1",
  requestId: "request-1",
};

describe("DecideJoinRequest — approve, happy path", () => {
  it("creates an active subscription with a null next_billing_date and enqueues exactly one grant_access row", async () => {
    const { decideJoinRequest, outboxCalls, createActiveWithoutBillingCalls, unitOfWork } =
      harness();

    const result = await decideJoinRequest.execute({ ...INPUT, decision: "approved" });

    expect(result.subscriptionId).toBe("subscription-1");
    expect(createActiveWithoutBillingCalls).toEqual([{ memberId: "member-1", tierId: "tier-1" }]);
    expect(outboxCalls).toHaveLength(1);
    expect(outboxCalls[0].eventType).toBe(OUTBOX_GRANT_ACCESS);
    expect(outboxCalls[0].payload).toEqual({ subscriptionId: "subscription-1" });
    // Exactly ONE unit of work — decide, createActiveWithoutBilling, the
    // enqueue and the activity_log write all share one transaction.
    expect(unitOfWork.runCallCount).toBe(1);
  });

  it("writes an activity_log row for the approval", async () => {
    const { decideJoinRequest, activityLogCalls } = harness();

    await decideJoinRequest.execute({ ...INPUT, decision: "approved" });

    expect(activityLogCalls).toHaveLength(1);
    expect(activityLogCalls[0].communityId).toBe("community-1");
    expect(activityLogCalls[0].memberId).toBe("member-1");
    expect(activityLogCalls[0].eventType).toBe("join_request_approved");
  });
});

describe("DecideJoinRequest — reject, happy path", () => {
  it("returns a null subscriptionId and sends nothing — no outbox row at all", async () => {
    const { decideJoinRequest, outboxCalls, createActiveWithoutBillingCalls } = harness();

    const result = await decideJoinRequest.execute({ ...INPUT, decision: "rejected" });

    expect(result).toEqual({ subscriptionId: null });
    expect(outboxCalls).toHaveLength(0);
    expect(createActiveWithoutBillingCalls).toHaveLength(0);
  });

  it("still writes an activity_log row", async () => {
    const { decideJoinRequest, activityLogCalls } = harness();

    await decideJoinRequest.execute({ ...INPUT, decision: "rejected" });

    expect(activityLogCalls).toHaveLength(1);
    expect(activityLogCalls[0].eventType).toBe("join_request_rejected");
  });
});

describe("DecideJoinRequest — approving twice", () => {
  it("enqueues exactly one grant_access row across two calls, and the second 409s", async () => {
    // `decide` returns true once, then false — modelling the conditional
    // UPDATE's own predicate (`status = 'pending'`) rather than re-reading it.
    const { decideJoinRequest, outboxCalls } = harness({ decideResults: [true, false] });

    const first = await decideJoinRequest.execute({ ...INPUT, decision: "approved" });
    expect(first.subscriptionId).toBe("subscription-1");

    const error = (await decideJoinRequest
      .execute({ ...INPUT, decision: "approved" })
      .catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe("permintaan ini sudah diproses");

    expect(outboxCalls).toHaveLength(1);
  });
});

describe("DecideJoinRequest — ownership", () => {
  it("404s a creator who does not own the community — never 403", async () => {
    const { decideJoinRequest } = harness({ community: null });

    await expect(
      decideJoinRequest.execute({ ...INPUT, decision: "approved" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("checks ownership with id first, creatorId second", async () => {
    const { decideJoinRequest, findByIdForCreatorCalls } = harness();

    await decideJoinRequest.execute({ ...INPUT, decision: "rejected" });

    expect(findByIdForCreatorCalls).toEqual([{ id: "community-1", creatorId: "creator-1" }]);
  });
});

describe("DecideJoinRequest — the request itself", () => {
  it("404s an unknown requestId", async () => {
    const { decideJoinRequest } = harness({ request: null });

    await expect(
      decideJoinRequest.execute({ ...INPUT, decision: "approved" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a request whose communityId belongs to a different community — never trusts the id alone", async () => {
    const { decideJoinRequest } = harness({
      request: { communityId: "some-other-community" },
    });

    await expect(
      decideJoinRequest.execute({ ...INPUT, decision: "approved" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DecideJoinRequest — tier no longer active", () => {
  it("409s approving a request for a deactivated tier", async () => {
    const { decideJoinRequest } = harness({ tiers: [tier({ isActive: false })] });

    const error = (await decideJoinRequest
      .execute({ ...INPUT, decision: "approved" })
      .catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe(
      "tier ini sudah tidak aktif. Aktifkan kembali tier tersebut atau tolak permintaan ini."
    );
  });

  /**
   * Fix round 1: this used to assert the OPPOSITE — that rejecting a
   * deactivated-tier request also 409s. That was a genuine deadlock: the
   * approval 409's own message tells the owner to reject instead, and
   * rejecting hit the exact same wall, with no escape that did not require
   * briefly reactivating (and republishing) a tier the owner deliberately
   * retired. Rejecting a pending request never touches the tier — it only
   * flips `join_request.status` — so a deactivated tier is not this
   * decision's business at all.
   */
  it("lets a rejection succeed even when the tier has been deactivated — rejecting never touches the tier", async () => {
    const { decideJoinRequest, activityLogCalls } = harness({
      tiers: [tier({ isActive: false })],
    });

    const result = await decideJoinRequest.execute({ ...INPUT, decision: "rejected" });

    expect(result).toEqual({ subscriptionId: null });
    expect(activityLogCalls).toHaveLength(1);
    expect(activityLogCalls[0].eventType).toBe("join_request_rejected");
  });
});

describe("DecideJoinRequest — the member already holds this tier actively", () => {
  it("409s from the graceful pre-check, before any transaction opens", async () => {
    const { decideJoinRequest, precheckCalls, decideCalls, outboxCalls, unitOfWork } = harness({
      precheckExisting: subscriptionRecord(),
    });

    const error = (await decideJoinRequest
      .execute({ ...INPUT, decision: "approved" })
      .catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe("anggota ini sudah menjadi member aktif di tier tersebut.");

    expect(precheckCalls).toEqual([{ memberId: "member-1", tierId: "tier-1" }]);
    // The pre-check refused it before `decide` was ever called — no unit of
    // work was opened, and nothing was written anywhere.
    expect(decideCalls).toHaveLength(0);
    expect(outboxCalls).toHaveLength(0);
    expect(unitOfWork.runCallCount).toBe(0);
  });

  it("does not run the pre-check for a rejection", async () => {
    const { decideJoinRequest, precheckCalls } = harness();

    await decideJoinRequest.execute({ ...INPUT, decision: "rejected" });

    expect(precheckCalls).toHaveLength(0);
  });

  /**
   * THE backstop. The pre-check above is a plain read and cannot close a race
   * between two decisions for the same (member, tier) — this proves the
   * unique-constraint catch INSIDE the transaction is what actually enforces
   * it: pre-check finds nothing, `decide` succeeds, and only the write itself
   * fails. Caught immediately and mapped to the SAME 409 message, and nothing
   * downstream of the failed write runs.
   */
  it("409s from the unique-constraint catch when the pre-check missed the race", async () => {
    const { decideJoinRequest, outboxCalls, activityLogCalls, decideCalls } = harness({
      precheckExisting: null,
      createActiveWithoutBillingImpl: async () => {
        throw new UniqueViolationError(
          UniqueRule.subscriptionMemberTierActive,
          "member already holds an active subscription to this tier"
        );
      },
    });

    const error = (await decideJoinRequest
      .execute({ ...INPUT, decision: "approved" })
      .catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe("anggota ini sudah menjadi member aktif di tier tersebut.");

    // `decide` DID run (it is what a real rollback would undo) but neither the
    // outbox enqueue nor the activity_log write — both come after the failed
    // create — ever happened.
    expect(decideCalls).toHaveLength(1);
    expect(outboxCalls).toHaveLength(0);
    expect(activityLogCalls).toHaveLength(0);
  });

  it("rethrows an unrelated error from createActiveWithoutBilling untouched", async () => {
    const boom = new Error("boom, unrelated to the unique constraint");
    const { decideJoinRequest } = harness({
      precheckExisting: null,
      createActiveWithoutBillingImpl: async () => {
        throw boom;
      },
    });

    await expect(decideJoinRequest.execute({ ...INPUT, decision: "approved" })).rejects.toBe(boom);
  });
});

describe("ListJoinRequests", () => {
  function listHarness(
    options: {
      community?: Partial<CommunityRecord> | null;
      rows?: PendingJoinRequestRow[];
    } = {}
  ) {
    const listCalls: string[] = [];

    const communities: CommunityRepositoryPort = {
      async create() {
        throw new Error("not used in these tests");
      },
      async findByIdForCreator(id, creatorId) {
        if (options.community === null) return null;
        return community({ id, ...options.community, creatorId });
      },
      async listByCreator() {
        throw new Error("not used in these tests");
      },
      async slugExists() {
        throw new Error("not used in these tests");
      },
      async update() {
        throw new Error("not used in these tests");
      },
      async findBySlug() {
        throw new Error("not used in these tests");
      },
    };

    const joinRequests: JoinRequestRepositoryPort = {
      async createPending() {
        throw new Error("not used in these tests");
      },
      async findById() {
        throw new Error("not used in these tests");
      },
      async listPendingForCommunity(communityId) {
        listCalls.push(communityId);
        return options.rows ?? [];
      },
      async decide() {
        throw new Error("not used in these tests");
      },
    };

    return { useCase: new ListJoinRequests(communities, joinRequests), listCalls };
  }

  it("lists pending requests for a community the caller owns", async () => {
    const row: PendingJoinRequestRow = {
      id: "request-1",
      memberId: "member-1",
      memberName: "Siti",
      memberWhatsappNumber: "+6281234567890",
      tierId: "tier-1",
      tierName: "Gratis",
      createdAt: new Date(0),
    };
    const { useCase, listCalls } = listHarness({ rows: [row] });

    const result = await useCase.execute({ communityId: "community-1", creatorId: "creator-1" });

    expect(result).toEqual([row]);
    expect(listCalls).toEqual(["community-1"]);
  });

  it("404s a stranger — never 403", async () => {
    const { useCase } = listHarness({ community: null });

    await expect(
      useCase.execute({ communityId: "community-1", creatorId: "creator-1" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
