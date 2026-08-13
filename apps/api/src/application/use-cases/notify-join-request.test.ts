import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { activityLogs, communities, creators, joinRequests, members, membershipTiers } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleJoinRequestRepository } from "../../infrastructure/repositories/drizzle-join-request.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import {
  CREATOR_WHATSAPP_MISSING_REASON,
  JOIN_REQUEST_CONTEXT_MISSING_REASON,
  JOIN_REQUEST_NOTIFY_SKIPPED_EVENT,
  NotifyJoinRequest,
  notifyJoinRequestOutboxHandler,
} from "./notify-join-request";

beforeEach(resetDatabase);

const joinRequestRepository = new DrizzleJoinRequestRepository(db);
const activityLogRepository = new DrizzleActivityLogRepository(db);

function buildUseCase(notifier: FakeMessagingAdapter) {
  return new NotifyJoinRequest(joinRequestRepository, activityLogRepository, notifier);
}

let seedCounter = 0;

/**
 * A creator -> free community -> tier -> member -> pending join request chain,
 * i.e. exactly what `RequestToJoin` leaves behind. `creatorWhatsappNumber:
 * null` lets a test cover the crux case this use-case exists for; every other
 * field defaults to a real value.
 */
async function seedPendingRequest(
  options: {
    creatorWhatsappNumber?: string | null;
    communityName?: string;
    memberName?: string | null;
    tierName?: string;
  } = {}
) {
  seedCounter += 1;
  const [creator] = await db
    .insert(creators)
    .values({
      name: "Rina",
      email: `rina-${seedCounter}@example.com`,
      whatsappNumber:
        options.creatorWhatsappNumber === undefined
          ? `+62810${String(seedCounter).padStart(6, "0")}`
          : options.creatorWhatsappNumber,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator!.id,
      name: options.communityName ?? "Kelas Rina",
      slug: `kelas-rina-${seedCounter}`,
      accessMode: "request",
    })
    .returning();
  const [tier] = await db
    .insert(membershipTiers)
    .values({
      communityId: community!.id,
      name: options.tierName ?? "Free",
      priceAmount: 0,
      billingCycle: "monthly",
    })
    .returning();
  const [member] = await db
    .insert(members)
    .values({
      whatsappNumber: `+62811${String(seedCounter).padStart(6, "0")}`,
      name: options.memberName === undefined ? "Siti" : options.memberName,
    })
    .returning();
  const [request] = await db
    .insert(joinRequests)
    .values({ communityId: community!.id, tierId: tier!.id, memberId: member!.id })
    .returning();
  return { creator: creator!, community: community!, tier: tier!, member: member!, request: request! };
}

async function activityRowsFor(joinRequestId: string) {
  const rows = await db.select().from(activityLogs);
  return rows.filter(
    (row) => (row.metadata as { joinRequestId?: string } | null)?.joinRequestId === joinRequestId
  );
}

describe("NotifyJoinRequest", () => {
  it("sends the owner one message naming the community, member and tier", async () => {
    const { creator, community, member, tier, request } = await seedPendingRequest();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ joinRequestId: request.id });

    expect(result).toEqual({ notified: true });
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe(creator.whatsappNumber!);
    expect(notifier.notifications[0]!.message).toBe(
      `Permintaan bergabung baru di ${community.name}: ${member.name} ingin bergabung ke ` +
        `tier ${tier.name}. Setujui atau tolak di dasbor DIUDARA.`
    );
  });

  it("never puts the member's WhatsApp number in the message", async () => {
    const { member, request } = await seedPendingRequest();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    await useCase.execute({ joinRequestId: request.id });

    expect(notifier.notifications[0]!.message).not.toContain(member.whatsappNumber);
  });

  it('renders a null member name as "Seseorang", never an empty string', async () => {
    const { community, tier, request } = await seedPendingRequest({ memberName: null });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    await useCase.execute({ joinRequestId: request.id });

    expect(notifier.notifications[0]!.message).toBe(
      `Permintaan bergabung baru di ${community.name}: Seseorang ingin bergabung ke ` +
        `tier ${tier.name}. Setujui atau tolak di dasbor DIUDARA.`
    );
    // No doubled space where the name would have been.
    expect(notifier.notifications[0]!.message).not.toContain("  ");
  });

  it("when the creator has no WhatsApp number, sends nothing and records the fact instead of retrying", async () => {
    const { request, member } = await seedPendingRequest({ creatorWhatsappNumber: null });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ joinRequestId: request.id });

    expect(result).toEqual({ notified: false, skippedReason: CREATOR_WHATSAPP_MISSING_REASON });
    expect(notifier.notifications).toHaveLength(0);

    const activity = await activityRowsFor(request.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe(JOIN_REQUEST_NOTIFY_SKIPPED_EVENT);
    expect(activity[0]!.memberId).toBe(member.id);
    expect((activity[0]!.metadata as { reason?: string }).reason).toBe(
      CREATOR_WHATSAPP_MISSING_REASON
    );
  });

  it("a join request that no longer exists is consumed rather than retried forever", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({
      joinRequestId: "00000000-0000-4000-8000-000000000000",
    });

    expect(result).toEqual({ notified: false, skippedReason: JOIN_REQUEST_CONTEXT_MISSING_REASON });
    expect(notifier.notifications).toHaveLength(0);
    // No `activity_log` row: there is no valid `communityId` left to attach one to.
    const rows = await db.select().from(activityLogs);
    expect(rows).toHaveLength(0);
  });

  // A request whose COMMUNITY or CREATOR has been deleted cannot be constructed
  // against the real schema: neither has a delete route in this codebase, and
  // every FK here is the Postgres default (`NO ACTION`), so a community with a
  // join request still pointing at it cannot be removed without violating the
  // constraint. `findNotificationContext`'s four INNER JOINs collapse THAT case
  // into the exact same `null` a vanished request produces — proven above — so
  // this is not a separate code path to exercise, only an unreachable trigger
  // for one already covered.
});

describe("notifyJoinRequestOutboxHandler", () => {
  it("rejects a payload with no usable joinRequestId", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const handler = notifyJoinRequestOutboxHandler(buildUseCase(notifier));

    await expect(handler({})).rejects.toThrow();
    await expect(handler({ joinRequestId: "" })).rejects.toThrow();
    await expect(handler(null)).rejects.toThrow();
    await expect(handler({ joinRequestId: 42 })).rejects.toThrow();
  });

  it("calls through to the use-case for a well-formed payload", async () => {
    const { creator, request } = await seedPendingRequest();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const handler = notifyJoinRequestOutboxHandler(buildUseCase(notifier));

    await handler({ joinRequestId: request.id });

    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe(creator.whatsappNumber!);
  });

  it("a well-formed payload for a vanished request does not throw — it is consumed", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const handler = notifyJoinRequestOutboxHandler(buildUseCase(notifier));

    await expect(
      handler({ joinRequestId: "00000000-0000-4000-8000-000000000000" })
    ).resolves.toBeUndefined();
  });
});
