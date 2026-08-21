import { describe, expect, it, beforeEach } from "bun:test";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  activityLogs,
  appUsers,
  communities,
  creators,
  joinRequests,
  members,
  membershipTiers,
  outbox,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleActivityLogRepository } from "../../infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleJoinRequestRepository } from "../../infrastructure/repositories/drizzle-join-request.repository";
import { DrizzleOutboxRepository } from "../../infrastructure/repositories/drizzle-outbox.repository";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import { OUTBOX_NOTIFY_JOIN_REQUEST } from "../ports/outbox-repository.port";
import { ProcessOutbox } from "./process-outbox";
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

/**
 * Block until POSTGRES agrees the row is due for another attempt.
 *
 * TWO CLOCKS, AND THEY DISAGREE. `ProcessOutbox` computes `next_attempt_at` in
 * this process (`new Date(Date.now() + backoff)`), while `claimBatch` selects on
 * `next_attempt_at <= now()` — `now()` being POSTGRES's clock, in the Docker VM.
 * Measured on this machine, that clock runs up to ~1.2 ms BEHIND the host's. With
 * `baseBackoffMs: 0` the whole margin is those few milliseconds, so a second pass
 * issued immediately can find the row "not yet due" and claim nothing.
 *
 * That is a clock artefact, not the behaviour under test — the test is about the
 * row being RETRIED rather than consumed, and about a later pass delivering it.
 * Asking the database for its own verdict removes the artefact without weakening
 * either claim. (Production never sees this: `DEFAULT_BASE_BACKOFF_MS` is 30 s,
 * where a millisecond of skew is irrelevant.)
 *
 * This is the same host-clock-vs-Postgres-clock mechanism behind the three
 * long-standing `updatedAt`-vs-`createdAt` flakes named in `docs/` — those
 * compare a JS-written `updated_at` against a Postgres-defaulted `created_at`
 * and miss by the same 1-3 ms.
 */
async function waitUntilDue(outboxRowId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const due = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.id, outboxRowId), lte(outbox.nextAttemptAt, sql`now()`)));
    if (due.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`outbox row ${outboxRowId} never became due within ${timeoutMs}ms`);
    }
    await Bun.sleep(2);
  }
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
    /**
     * Task 7. Pass to give the owner an `app_user` account on the SAME email
     * address as their `creator` row — the only join between the two tables,
     * since there is no foreign key. Omit for an owner who has no account,
     * which is every owner the pre-Task-7 tests seed.
     */
    appUserWhatsappNumber?: string | null;
  } = {}
) {
  seedCounter += 1;
  const creatorEmail = `rina-${seedCounter}@example.com`;
  const [creator] = await db
    .insert(creators)
    .values({
      name: "Rina",
      email: creatorEmail,
      whatsappNumber:
        options.creatorWhatsappNumber === undefined
          ? `+62810${String(seedCounter).padStart(6, "0")}`
          : options.creatorWhatsappNumber,
    })
    .returning();
  if (options.appUserWhatsappNumber !== undefined) {
    await db.insert(appUsers).values({
      handle: `rina${seedCounter}`,
      email: creatorEmail,
      whatsappNumber: options.appUserWhatsappNumber,
      passwordHash: "argon2id$placeholder",
      displayName: "Rina",
    });
  }
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

  /**
   * Fix round 1. The two consume-don't-retry cases above are deliberately NOT
   * how a TRANSIENT failure (the provider being down) must behave — the outbox
   * still needs to retry that, and nothing had proven it. `execute`'s send is a
   * bare, uncaught `await this.notifier.notify(...)`, so a throw there must
   * reach the caller rather than being swallowed into a `notified: false` skip
   * result, which is exactly the "accidental widening" the crux of this task
   * warns against — a WhatsApp outage must not silently look identical to a
   * creator who never set a number.
   */
  it("a transient send failure propagates rather than being converted into a skip", async () => {
    const { request } = await seedPendingRequest();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    notifier.failNextNotify = true;
    const useCase = buildUseCase(notifier);

    await expect(useCase.execute({ joinRequestId: request.id })).rejects.toThrow();

    // Not recorded as a skip: this is not a case the design treats as "nothing
    // fixable by a retry" — the whole point is that a retry CAN fix it.
    const activity = await activityRowsFor(request.id);
    expect(activity).toHaveLength(0);
  });
});

/**
 * Task 7. The machinery above was correct and still notified nobody: the number
 * it reads, `creator.whatsapp_number`, has no editor anywhere in the app, so it
 * is null for every owner alive and the skip path fires every single time. The
 * number an owner CAN edit is `app_user.whatsapp_number` (Phase 1), reached
 * through the one join available — `creator.email` = `app_user.email`, since
 * `creator` is a /dashboard/* table whose shape must not change and there is no
 * foreign key between the two.
 *
 * These run against the REAL repository, which is what makes them able to
 * disagree with the SQL; a fake repository could only restate the mapping.
 */
describe("the owner's number is read from app_user, where it is editable", () => {
  it("notifies an owner who is only reachable through their app_user account", async () => {
    const { request } = await seedPendingRequest({
      creatorWhatsappNumber: null,
      appUserWhatsappNumber: "+628999990011",
    });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ joinRequestId: request.id });

    expect(result).toEqual({ notified: true });
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe("+628999990011");
    // Not recorded as unreachable: this is the case the whole task exists to fix.
    expect(await activityRowsFor(request.id)).toHaveLength(0);
  });

  /**
   * THE ANTI-INNER-JOIN TEST, at this layer. An INNER JOIN onto `app_user`
   * would stop notifying every creator without an account — people who ARE
   * being notified today. `seedPendingRequest` creates no account unless asked.
   */
  it("still notifies an owner who has no app_user account, on their creator number", async () => {
    const { request } = await seedPendingRequest({ creatorWhatsappNumber: "+628130009911" });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ joinRequestId: request.id });

    expect(result).toEqual({ notified: true });
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe("+628130009911");
  });

  it("sends to the app_user number, NOT the creator's, when the owner has both", async () => {
    const { request } = await seedPendingRequest({
      creatorWhatsappNumber: "+628130009922",
      appUserWhatsappNumber: "+628999990022",
    });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    await useCase.execute({ joinRequestId: request.id });

    // Both literals asserted: which of the two numbers was used is the whole
    // claim, and asserting only "one message went out" would not make it.
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe("+628999990022");
    expect(notifier.notifications[0]!.toWhatsappNumber).not.toBe("+628130009922");
  });

  it("falls back to the creator's number when the owner's account has none", async () => {
    const { request } = await seedPendingRequest({
      creatorWhatsappNumber: "+628130009933",
      appUserWhatsappNumber: null,
    });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    await useCase.execute({ joinRequestId: request.id });

    expect(notifier.notifications[0]!.toWhatsappNumber).toBe("+628130009933");
  });

  /**
   * The skip path still fires, and still fires with the SAME `event_type` and
   * `reason` — asserted as literal strings rather than as the constants that
   * define them, so renaming either constant shows up here as a failure rather
   * than as a test that silently follows it.
   */
  it("records the skip, unchanged, for an owner with neither number", async () => {
    const { member, request } = await seedPendingRequest({
      creatorWhatsappNumber: null,
      appUserWhatsappNumber: null,
    });
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);

    const result = await useCase.execute({ joinRequestId: request.id });

    expect(result).toEqual({ notified: false, skippedReason: "creator_whatsapp_missing" });
    expect(notifier.notifications).toHaveLength(0);
    const activity = await activityRowsFor(request.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe("join_request_notify_skipped");
    expect(activity[0]!.memberId).toBe(member.id);
    expect((activity[0]!.metadata as { reason?: string }).reason).toBe("creator_whatsapp_missing");
  });
});

/**
 * Fix round 1's headline gap: `bun run test` passed 1591/1591 even after the
 * reviewer wrapped `notify` in a try/catch that turned a provider outage into
 * a silent `notified: false` skip. These two facts were unpinned:
 *   1. the throw actually reaches `ProcessOutbox`, so the row is RETRIED, not
 *      marked `sent`;
 *   2. a later pass, once the provider recovers, actually delivers it.
 * Driven through the REAL worker wiring — `notifyJoinRequestOutboxHandler` and
 * `ProcessOutbox` together — the same shape `send-renewal-reminder.test.ts`
 * uses for its own send failure, not a bare use-case call.
 */
describe("a failed send retries through the outbox", () => {
  it("RETRIES rather than consuming the row, and a later pass delivers", async () => {
    const { creator, request } = await seedPendingRequest();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const useCase = buildUseCase(notifier);
    const outboxRepository = new DrizzleOutboxRepository(db);
    const { id } = await outboxRepository.enqueue({
      eventType: OUTBOX_NOTIFY_JOIN_REQUEST,
      payload: { joinRequestId: request.id },
    });
    const processOutbox = new ProcessOutbox(
      outboxRepository,
      new Map([[OUTBOX_NOTIFY_JOIN_REQUEST, notifyJoinRequestOutboxHandler(useCase)]]),
      // baseBackoffMs 0 so the retry is immediately due.
      { maxAttempts: 5, baseBackoffMs: 0 }
    );

    notifier.failNextNotify = true;
    const failed = await processOutbox.execute();

    expect(failed.claimed).toBe(1);
    expect(failed.sent).toBe(0);
    expect(failed.retried).toBe(1);
    expect(notifier.notifications).toHaveLength(0);
    const [pending] = await db.select().from(outbox).where(eq(outbox.id, id));
    expect(pending.status).toBe("pending");
    expect(pending.lastError).toContain("notify");
    // Never treated as the crux case this task exists for: the provider being
    // down is not the creator having no WhatsApp number, and must not be
    // recorded as though it were.
    expect(await activityRowsFor(request.id)).toHaveLength(0);

    // The retry, once the provider is healthy again, actually delivers.
    // See `waitUntilDue` for why this is not simply a second `execute()`.
    await waitUntilDue(id);
    const delivered = await processOutbox.execute();

    expect(delivered.sent).toBe(1);
    const [settled] = await db.select().from(outbox).where(eq(outbox.id, id));
    expect(settled.status).toBe("sent");
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]!.toWhatsappNumber).toBe(creator.whatsappNumber!);
  });
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
