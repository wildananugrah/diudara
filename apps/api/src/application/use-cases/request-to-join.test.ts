import { describe, expect, it } from "bun:test";
import { GetJoinRequestStatus, RequestToJoin } from "./request-to-join";
import { ConflictError, NotFoundError } from "../errors";
import { OUTBOX_NOTIFY_JOIN_REQUEST } from "../ports/outbox-repository.port";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  MembershipTierRepositoryPort,
  TierRecord,
} from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type {
  SubscriptionRecord,
  SubscriptionRepositoryPort,
} from "../ports/subscription-repository.port";
import type {
  JoinRequestRecord,
  JoinRequestRepositoryPort,
  PendingJoinRequestRow,
} from "../ports/join-request-repository.port";
import type { JoinRequestRepositories, JoinRequestUnitOfWorkPort } from "../ports/join-request-unit-of-work.port";

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

/**
 * A fake unit of work that simply runs `work` against the fakes it was built
 * with. `runCallCount` exists so a test can pin ATOMICITY itself: this fake
 * cannot see whether the two writes inside `work` genuinely share a Postgres
 * transaction (only `drizzle-join-request-unit-of-work.test.ts` can prove
 * that, against the real adapter) — but it CAN prove that `RequestToJoin`
 * asks for exactly ONE unit of work per request, rather than one per write. A
 * refactor that split the create and the enqueue into two separate
 * `unitOfWork.run(...)` calls would keep every other test green (this fake
 * has no way to fail a split into two successful, sequential transactions)
 * and only this counter would catch it.
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
 * A minimal RequestToJoin wired to fake ports, one knob per refusal this
 * use-case has to apply. `createPendingResult` defaults to a fresh pending
 * row; set it to `null` to simulate the unique index refusing a duplicate.
 */
function harness(
  options: {
    community?: Partial<CommunityRecord> | null;
    tiers?: TierRecord[];
    hasLiveSubscription?: boolean;
    createPendingResult?: JoinRequestRecord | null;
  } = {}
) {
  const outboxCalls: { eventType: string; payload: unknown }[] = [];
  const createPendingCalls: { communityId: string; tierId: string; memberId: string }[] = [];
  const activeSubscriptionChecks: { memberId: string; communityId: string }[] = [];
  const findOrCreateCalls: { whatsappNumber: string; name: string }[] = [];

  const communities: CommunityRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByIdForCreator() {
      throw new Error("not used: the public route has no authenticated caller");
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
    async findBySlug(slug) {
      if (options.community === null) return null;
      return community({ slug, ...options.community });
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

  const members: MemberRepositoryPort = {
    async findOrCreateByWhatsappNumber(input) {
      findOrCreateCalls.push(input);
      return { id: "member-1", whatsappNumber: input.whatsappNumber, name: input.name, joinedAt: new Date(0) };
    },
    async findById() {
      throw new Error("not used in these tests");
    },
  };

  const subscriptions: SubscriptionRepositoryPort = {
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
    async hasLiveSubscriptionInCommunity(memberId, communityId) {
      activeSubscriptionChecks.push({ memberId, communityId });
      return options.hasLiveSubscription ?? false;
    },
    async findRenewalContext() {
      throw new Error("not used in these tests");
    },
    async listActiveForCommunity() {
      throw new Error("not used in these tests");
    },
  };

  const joinRequests: JoinRequestRepositoryPort = {
    async createPending(input) {
      createPendingCalls.push(input);
      if (options.createPendingResult === null) return null;
      return options.createPendingResult ?? joinRequestRecord(input);
    },
    async findById() {
      throw new Error("not used in these tests");
    },
    async listPendingForCommunity() {
      throw new Error("not used in these tests");
    },
    async decide() {
      throw new Error("not used in these tests");
    },
  };

  const unitOfWork = new FakeJoinRequestUnitOfWork({
    joinRequests,
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
      async record() {
        throw new Error("not used: RequestToJoin writes no activity_log entry — only the owner's decision does");
      },
    },
    // Task 4's addition to the port. RequestToJoin never reaches into
    // `repositories.subscriptions` (it only calls the pooled `subscriptions`
    // above, via `hasLiveSubscriptionInCommunity`), so reusing that same fake
    // here just satisfies the type.
    subscriptions,
  });

  const requestToJoin = new RequestToJoin(communities, tiers, members, subscriptions, unitOfWork);

  return {
    requestToJoin,
    outboxCalls,
    createPendingCalls,
    activeSubscriptionChecks,
    findOrCreateCalls,
    unitOfWork,
  };
}

const REQUEST = {
  slug: "kelas-rina",
  tierId: "tier-1",
  payerName: "Siti",
  payerWhatsappNumber: "+6281234567890",
};

describe("RequestToJoin — happy path", () => {
  it("creates a pending request and enqueues exactly one notify_join_request row", async () => {
    const { requestToJoin, outboxCalls, createPendingCalls, unitOfWork } = harness();

    const result = await requestToJoin.execute(REQUEST);

    expect(result.joinRequestId).toBe("request-1");
    expect(createPendingCalls).toEqual([
      { communityId: "community-1", tierId: "tier-1", memberId: "member-1" },
    ]);
    expect(outboxCalls).toHaveLength(1);
    expect(outboxCalls[0].eventType).toBe(OUTBOX_NOTIFY_JOIN_REQUEST);
    expect(outboxCalls[0].payload).toEqual({ joinRequestId: "request-1" });

    // Pins ATOMICITY at the call-site: exactly ONE unit of work for the whole
    // request, not one per write. A refactor that split `createPending` and
    // `outbox.enqueue` into two separate `unitOfWork.run(...)` calls would keep
    // every assertion above green — this counter is the one thing that would
    // catch it. See `FakeJoinRequestUnitOfWork`'s own docstring.
    expect(unitOfWork.runCallCount).toBe(1);
  });

  it("resolves the member via findOrCreateByWhatsappNumber before checking membership", async () => {
    const { requestToJoin, findOrCreateCalls, activeSubscriptionChecks } = harness();

    await requestToJoin.execute(REQUEST);

    expect(findOrCreateCalls).toEqual([
      { whatsappNumber: "+6281234567890", name: "Siti" },
    ]);
    expect(activeSubscriptionChecks).toEqual([
      { memberId: "member-1", communityId: "community-1" },
    ]);
  });
});

describe("RequestToJoin — community refusals", () => {
  it("404s an unknown slug", async () => {
    const { requestToJoin } = harness({ community: null });

    await expect(requestToJoin.execute(REQUEST)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an archived community", async () => {
    const { requestToJoin } = harness({ community: { status: "archived" } });

    await expect(requestToJoin.execute(REQUEST)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("409s a paused community, StartCheckout's own message", async () => {
    const { requestToJoin } = harness({ community: { status: "paused" } });

    const error = (await requestToJoin.execute(REQUEST).catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe("komunitas ini sedang tidak menerima anggota baru");
  });

  /**
   * THE guard this whole phase exists for. A `paid` community must 404 on
   * this route — never fall back to accepting a free join because payments
   * happen to be unconfigured on this box. See RequestToJoin's own docstring.
   */
  it("404s a paid community — never falls back to a free join", async () => {
    const { requestToJoin, createPendingCalls, outboxCalls } = harness({
      community: { accessMode: "paid" },
    });

    await expect(requestToJoin.execute(REQUEST)).rejects.toBeInstanceOf(NotFoundError);
    expect(createPendingCalls).toHaveLength(0);
    expect(outboxCalls).toHaveLength(0);
  });

  it("404s an accessMode this box does not recognise, same fail-closed rule as status", async () => {
    const { requestToJoin } = harness({ community: { accessMode: "something-else" } });

    await expect(requestToJoin.execute(REQUEST)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("RequestToJoin — tier refusals", () => {
  it("404s a tierId that does not belong to this community", async () => {
    const { requestToJoin } = harness({ tiers: [tier({ id: "other-tier" })] });

    await expect(requestToJoin.execute(REQUEST)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an inactive tier", async () => {
    const { requestToJoin } = harness({ tiers: [tier({ isActive: false })] });

    await expect(requestToJoin.execute(REQUEST)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("RequestToJoin — already a member", () => {
  it("409s with a message pointing at the WhatsApp invite, before any request is created", async () => {
    const { requestToJoin, createPendingCalls, outboxCalls } = harness({
      hasLiveSubscription: true,
    });

    const error = (await requestToJoin.execute(REQUEST).catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe(
      "Anda sudah menjadi anggota komunitas ini. Cek WhatsApp Anda untuk tautan undangan grup."
    );
    expect(createPendingCalls).toHaveLength(0);
    expect(outboxCalls).toHaveLength(0);
  });
});

/**
 * I1-shaped: the transaction is the point of step 7. `createPending` returning
 * `null` means the unique index refused a duplicate pending request, and
 * NOTHING may be enqueued for it — an orphaned notification for a request
 * that does not exist would tell the owner about something they can never
 * find.
 */
describe("RequestToJoin — duplicate pending request", () => {
  it("409s and enqueues NO outbox row when createPending returns null", async () => {
    const { requestToJoin, outboxCalls } = harness({ createPendingResult: null });

    const error = (await requestToJoin.execute(REQUEST).catch((e) => e)) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe("permintaan Anda sudah menunggu persetujuan pemilik komunitas");

    // THE assertion that matters: no outbox row exists for a request that was
    // never created.
    expect(outboxCalls).toHaveLength(0);
  });
});

describe("GetJoinRequestStatus", () => {
  function statusHarness(
    options: {
      community?: Partial<CommunityRecord> | null;
      request?: Partial<JoinRequestRecord> | null;
      currentSubscription?: SubscriptionRecord | null;
    } = {}
  ) {
    const communities: CommunityRepositoryPort = {
      async create() {
        throw new Error("not used in these tests");
      },
      async findByIdForCreator() {
        throw new Error("not used in these tests");
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
      async findBySlug(slug) {
        if (options.community === null) return null;
        return community({ slug, ...options.community });
      },
    };

    const joinRequests: JoinRequestRepositoryPort = {
      async createPending() {
        throw new Error("not used in these tests");
      },
      async findById() {
        if (options.request === null) return null;
        return joinRequestRecord(options.request);
      },
      async listPendingForCommunity(): Promise<PendingJoinRequestRow[]> {
        throw new Error("not used in these tests");
      },
      async decide() {
        throw new Error("not used in these tests");
      },
    };

    const subscriptions: SubscriptionRepositoryPort = {
      async createPending() {
        throw new Error("not used in these tests");
      },
      async createActiveWithoutBilling() {
        throw new Error("not used in these tests");
      },
      async findCurrentSubscriptionForTier() {
        return options.currentSubscription ?? null;
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

    return new GetJoinRequestStatus(communities, joinRequests, subscriptions);
  }

  it("returns pending status with no subscriptionId", async () => {
    const useCase = statusHarness({ request: { status: "pending" } });

    const result = await useCase.execute("kelas-rina", "request-1");

    expect(result).toEqual({
      status: "pending",
      communitySlug: "kelas-rina",
      subscriptionId: null,
    });
  });

  it("returns rejected status with no subscriptionId", async () => {
    const useCase = statusHarness({ request: { status: "rejected" } });

    const result = await useCase.execute("kelas-rina", "request-1");

    expect(result.status).toBe("rejected");
    expect(result.subscriptionId).toBeNull();
  });

  it("resolves subscriptionId once approved", async () => {
    const useCase = statusHarness({
      request: { status: "approved", memberId: "member-1", tierId: "tier-1" },
      currentSubscription: {
        id: "subscription-9",
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
      },
    });

    const result = await useCase.execute("kelas-rina", "request-1");

    expect(result).toEqual({
      status: "approved",
      communitySlug: "kelas-rina",
      subscriptionId: "subscription-9",
    });
  });

  it("404s an unknown community", async () => {
    const useCase = statusHarness({ community: null });

    await expect(useCase.execute("kelas-rina", "request-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an unknown join request id", async () => {
    const useCase = statusHarness({ request: null });

    await expect(useCase.execute("kelas-rina", "request-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a join request that belongs to a different community", async () => {
    const useCase = statusHarness({ request: { communityId: "some-other-community" } });

    await expect(useCase.execute("kelas-rina", "request-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("never leaks the member's name or WhatsApp number", async () => {
    const useCase = statusHarness({ request: { status: "pending" } });

    const result = await useCase.execute("kelas-rina", "request-1");

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("Siti");
    expect(serialised).not.toContain("+6281234567890");
    // And no key that could carry either, not just these particular values.
    expect(Object.keys(result).sort()).toEqual(["communitySlug", "status", "subscriptionId"]);
  });
});
