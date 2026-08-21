import { describe, expect, it } from "bun:test";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { FakeEmailAdapter } from "../../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import type { EmailProviderPort } from "../ports/email-provider.port";
import type {
  MembershipReminderRepositoryPort,
  MembershipReminderRow,
} from "../ports/membership-reminder-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { UserSubscriptionRow } from "../ports/user-subscription-repository.port";
import {
  RemindExpiringMembership,
  type ExpiringMembershipRepository,
} from "./remind-expiring-membership";

/**
 * Task 4 of Phase 5b: reminding a member BEFORE their membership ends.
 *
 * There is no recurring charge anywhere in this system, so a membership does not
 * renew — it ends, and the member buys again. This pass is the only thing that tells
 * them to. Every literal below is written out rather than imported from the
 * implementation, so a change of window, of copy or of channel has to be made twice
 * on purpose.
 */

const NOW = new Date("2026-08-21T00:00:00.000Z");
/** Inside the three-day lead: the member should be reminded. */
const ENDS_IN_TWO_DAYS = new Date("2026-08-23T00:00:00.000Z");
const APP_BASE_URL = "https://diudara.test";

function subscriberRow(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "subscriber-1",
    handle: "rina",
    email: "rina@example.com",
    whatsappNumber: "6281234567890",
    displayName: "Rina",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function ownerRow(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "owner-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: null,
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function subscriptionRow(overrides: Partial<UserSubscriptionRow> = {}): UserSubscriptionRow {
  return {
    id: "sub-1",
    subscriberId: "subscriber-1",
    tierId: "tier-1",
    ownerId: "owner-1",
    status: "active",
    currentPeriodEnd: ENDS_IN_TWO_DAYS,
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * In-memory `app_user` reads. Every method except `findById` throws: this pass reads
 * users and must never write to, or search, `app_user`.
 */
function fakeUsers(seed: UserRecord[]): UserRepositoryPort {
  const rows = seed.map((row) => ({ ...row }));
  const unsupported = () => {
    throw new Error("RemindExpiringMembership must not touch app_user beyond reading it by id");
  };
  return {
    create: unsupported,
    findByHandle: unsupported,
    async findById(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    findByEmail: unsupported,
    findCredentialsByEmail: unsupported,
    updateProfile: unsupported,
    setPasswordAndBumpEpoch: unsupported,
    searchPublic: unsupported,
    newestPublic: unsupported,
    mostFollowedPublic: unsupported,
  } as UserRepositoryPort;
}

/**
 * The claim table, in memory, arbitrated exactly the way the real
 * `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE outcome = 'no_channel'` arbitrates:
 * the first caller for a subscription id gets `true`, a later caller gets `false` —
 * UNLESS the only thing on record is a `no_channel` skip, which is re-claimable
 * because it describes a broken box rather than an unreachable member. Kept in step
 * with `DrizzleMembershipReminderRepository.claim` deliberately; a fake that were more
 * permissive than the real one would let a double-send through here unnoticed.
 * `claimCalls` records every call so a test can prove the claim happened BEFORE the
 * send rather than merely alongside it.
 */
function fakeReminders() {
  const rows = new Map<string, MembershipReminderRow>();
  const claimCalls: string[] = [];
  const port: MembershipReminderRepositoryPort = {
    async claim(userSubscriptionId) {
      claimCalls.push(userSubscriptionId);
      const held = rows.get(userSubscriptionId);
      if (held !== undefined && held.outcome !== "no_channel") return false;
      rows.set(userSubscriptionId, {
        id: held?.id ?? `reminder-${rows.size + 1}`,
        userSubscriptionId,
        outcome: "claimed",
        channels: null,
        claimedAt: NOW,
      });
      return true;
    },
    async recordOutcome({ userSubscriptionId, outcome, channels }) {
      const row = rows.get(userSubscriptionId);
      if (!row) return false;
      rows.set(userSubscriptionId, { ...row, outcome, channels });
      return true;
    },
    async release(userSubscriptionId) {
      return rows.delete(userSubscriptionId);
    },
    async findBySubscriptionId(userSubscriptionId) {
      return rows.get(userSubscriptionId) ?? null;
    },
  };
  return { port, rows, claimCalls };
}

/** Whatever `listExpiringActive` is asked for, it hands back these rows once. */
function fakeSubscriptions(pages: UserSubscriptionRow[][]) {
  const calls: {
    from: Date;
    to: Date;
    limit: number;
    after?: { currentPeriodEnd: Date; id: string };
  }[] = [];
  const remaining = pages.map((page) => page.map((row) => ({ ...row })));
  const repository: ExpiringMembershipRepository = {
    async listExpiringActive(input) {
      calls.push(input);
      return remaining.shift() ?? [];
    },
  };
  return { repository, calls };
}

function build(options: {
  subscriptions: ExpiringMembershipRepository;
  users: UserRepositoryPort;
  reminders: MembershipReminderRepositoryPort;
  email: EmailProviderPort | null;
  notifier: FakeMessagingAdapter | null;
  batchSize?: number;
  logWarn?: (line: string) => void;
  logError?: (line: string) => void;
}) {
  return new RemindExpiringMembership(
    options.subscriptions,
    options.users,
    options.reminders,
    options.email,
    options.notifier,
    new FixedClock(NOW),
    { appBaseUrl: APP_BASE_URL },
    {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.logWarn === undefined ? {} : { logWarn: options.logWarn }),
      ...(options.logError === undefined ? {} : { logError: options.logError }),
    }
  );
}

describe("RemindExpiringMembership", () => {
  it("sends to EMAIL always, and to WhatsApp as well when the member has a number", async () => {
    const email = new FakeEmailAdapter();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const { port: reminders, rows } = fakeReminders();
    const useCase = build({
      subscriptions: fakeSubscriptions([[subscriptionRow()]]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier,
    });

    const result = await useCase.execute();

    expect(result.reminded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(email.sent.length).toBe(1);
    expect(email.sent[0].to).toBe("rina@example.com");
    expect(notifier.notifications.length).toBe(1);
    expect(notifier.notifications[0].toWhatsappNumber).toBe("6281234567890");
    // Both channels carry the SAME message.
    expect(notifier.notifications[0].message).toBe(email.sent[0].body);
    // Recorded as reached, and by what.
    expect(rows.get("sub-1")?.outcome).toBe("sent");
    expect(rows.get("sub-1")?.channels).toBe("email,whatsapp");
  });

  it("writes the reminder in Bahasa Indonesia, naming the end date and a link back to the creator", async () => {
    const email = new FakeEmailAdapter();
    const useCase = build({
      subscriptions: fakeSubscriptions([[subscriptionRow()]]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders: fakeReminders().port,
      email,
      notifier: null,
    });

    await useCase.execute();

    const sent = email.sent[0];
    expect(sent.subject).toBe("Keanggotaan Anda untuk @wildan akan segera berakhir");
    expect(sent.body).toContain("Halo Rina,");
    // 2026-08-23T00:00 UTC is 07:00 on the 23rd in WIB — the day the member keeps.
    expect(sent.body).toContain("berakhir pada 23 Agustus 2026");
    expect(sent.body).toContain("Tidak ada perpanjangan otomatis");
    expect(sent.body).toContain("https://diudara.test/@wildan");
    // Never an amount and never a tier: prices can change and a tier can be
    // deactivated between this message and the member acting on it.
    expect(sent.body).not.toContain("Rp");
  });

  it("names the end date as the member's own WIB calendar day, not UTC's", async () => {
    // 22:00 WIB on the 23rd is still the 23rd to the member; in UTC it is already the
    // 22nd's evening... and an hour later it is the 24th. Getting this wrong tells a
    // member their membership ends a day earlier or later than it does, which is the
    // one fact the message exists to carry. Asia/Jakarta is UTC+7 all year — Indonesia
    // has never observed daylight saving — so the shift is a constant, not a lookup.
    const email = new FakeEmailAdapter();
    const useCase = build({
      subscriptions: fakeSubscriptions([
        [subscriptionRow({ currentPeriodEnd: new Date("2026-08-23T20:00:00.000Z") })],
      ]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders: fakeReminders().port,
      email,
      notifier: null,
    });

    await useCase.execute();

    // 2026-08-23T20:00Z is 2026-08-24T03:00 WIB.
    expect(email.sent[0].body).toContain("berakhir pada 24 Agustus 2026");
  });

  it("sends to email only when the member has no WhatsApp number", async () => {
    // `app_user.whatsapp_number` is nullable — signup offers it and never requires it.
    const email = new FakeEmailAdapter();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const { port: reminders, rows } = fakeReminders();
    const useCase = build({
      subscriptions: fakeSubscriptions([[subscriptionRow()]]).repository,
      users: fakeUsers([subscriberRow({ whatsappNumber: null }), ownerRow()]),
      reminders,
      email,
      notifier,
    });

    const result = await useCase.execute();

    expect(result.reminded).toBe(1);
    expect(email.sent.length).toBe(1);
    expect(notifier.notifications.length).toBe(0);
    expect(rows.get("sub-1")?.channels).toBe("email");
  });

  it("RECORDS a skip when neither channel can deliver, rather than passing over it silently", async () => {
    // Both adapters are optional at boot. "the member was never told" is the failure
    // mode this pass exists to prevent, so the intentional case must be visible.
    const { port: reminders, rows } = fakeReminders();
    const warnings: string[] = [];
    const useCase = build({
      subscriptions: fakeSubscriptions([[subscriptionRow()]]).repository,
      users: fakeUsers([subscriberRow({ whatsappNumber: null }), ownerRow()]),
      reminders,
      // No email provider on this box, and no number on file: nobody can be reached.
      email: null,
      notifier: null,
      logWarn: (line) => warnings.push(line),
    });

    const result = await useCase.execute();

    expect(result.considered).toBe(1);
    expect(result.reminded).toBe(0);
    expect(result.skipped).toBe(1);
    // IN THE DATABASE, not only in a counter: a row survives the pass saying the
    // member was deliberately not told.
    expect(rows.get("sub-1")?.outcome).toBe("no_channel");
    expect(rows.get("sub-1")?.channels).toBe(null);
    // And in the log, so an operator can grep it apart from a pass that worked.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("NO CHANNEL AVAILABLE");
    expect(warnings[0]).toContain("sub-1");
    // Never the address or the number, even though both were on the record read.
    expect(warnings[0]).not.toContain("rina@example.com");
  });

  it("RETRIES a membership skipped for want of a channel once a channel exists", async () => {
    // Review fix round 1, I1. The skip records the BOX, not the member: every account
    // has an email address, so "no channel at all" means this deployment has no email
    // provider. A worker deployed for an hour without one must not permanently burn
    // the reminder for every in-window member who has no WhatsApp number.
    const { port: reminders, rows } = fakeReminders();
    const subscriptions = [subscriptionRow()];
    const users = fakeUsers([subscriberRow({ whatsappNumber: null }), ownerRow()]);

    const broken = build({
      subscriptions: fakeSubscriptions([subscriptions]).repository,
      users,
      reminders,
      email: null,
      notifier: null,
      logWarn: () => undefined,
    });
    const first = await broken.execute();
    expect(first.skipped).toBe(1);
    expect(rows.get("sub-1")?.outcome).toBe("no_channel");

    // Somebody configures email. The next pass on the repaired box must send.
    const email = new FakeEmailAdapter();
    const repaired = build({
      subscriptions: fakeSubscriptions([subscriptions]).repository,
      users,
      reminders,
      email,
      notifier: null,
    });
    const second = await repaired.execute();

    expect(second.reminded).toBe(1);
    expect(second.alreadyReminded).toBe(0);
    expect(email.sent.length).toBe(1);
    expect(email.sent[0].to).toBe("rina@example.com");
    expect(rows.get("sub-1")?.outcome).toBe("sent");
    expect(rows.get("sub-1")?.channels).toBe("email");
  });

  it("still never reminds a SENT membership twice, however many later passes run", async () => {
    // The half that must not break while fixing the one above. Three passes on a
    // fully working box after a successful send: one email, one WhatsApp, ever.
    const email = new FakeEmailAdapter();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const { port: reminders, rows } = fakeReminders();
    const subscriptions = [subscriptionRow()];
    const useCase = build({
      subscriptions: fakeSubscriptions([subscriptions, subscriptions, subscriptions]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier,
    });

    const first = await useCase.execute();
    const second = await useCase.execute();
    const third = await useCase.execute();

    expect(first.reminded).toBe(1);
    expect(second.alreadyReminded).toBe(1);
    expect(third.alreadyReminded).toBe(1);
    expect(email.sent.length).toBe(1);
    expect(notifier.notifications.length).toBe(1);
    expect(rows.get("sub-1")?.outcome).toBe("sent");
  });

  it("claims before sending, so a pass that runs twice reminds once", async () => {
    // Two passes over the same subscription produce exactly one send per channel.
    const email = new FakeEmailAdapter();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const { port: reminders } = fakeReminders();
    const rows = [subscriptionRow()];
    const useCase = build({
      subscriptions: fakeSubscriptions([rows, rows]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier,
    });

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(0);
    expect(second.alreadyReminded).toBe(1);
    expect(email.sent.length).toBe(1);
    expect(notifier.notifications.length).toBe(1);
  });

  it("takes the claim BEFORE the first send, so a crash mid-send cannot remind twice", async () => {
    const order: string[] = [];
    const { port: inner } = fakeReminders();
    const reminders: MembershipReminderRepositoryPort = {
      async claim(id) {
        order.push("claim");
        return inner.claim(id);
      },
      recordOutcome: inner.recordOutcome,
      release: inner.release,
      findBySubscriptionId: inner.findBySubscriptionId,
    };
    const email: EmailProviderPort = {
      async send() {
        order.push("send");
      },
    };
    const useCase = build({
      subscriptions: fakeSubscriptions([[subscriptionRow()]]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier: null,
    });

    await useCase.execute();

    expect(order).toEqual(["claim", "send"]);
  });

  it("obeys the CLAIM and never a read, so a losing pass sends nothing even while the table looks empty to it", async () => {
    // THE TOCTOU, expressed as a test. A pass that decided by READING
    // `membership_reminder` first would pass every other test in this file, because a
    // sequential fake orders the reads — and would then send a second reminder in
    // production, where two overlapping passes both read "not yet" before either
    // commits. So the repository below answers the read the way a losing pass's read
    // genuinely answers (nothing there yet) while the CLAIM refuses. Only an
    // implementation that routes on `claim`'s return value sends nothing here.
    const email = new FakeEmailAdapter();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const reminders: MembershipReminderRepositoryPort = {
      async claim() {
        return false;
      },
      async recordOutcome() {
        return true;
      },
      async release() {
        return true;
      },
      async findBySubscriptionId() {
        return null;
      },
    };
    const useCase = build({
      subscriptions: fakeSubscriptions([[subscriptionRow()]]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier,
    });

    const result = await useCase.execute();

    expect(result.alreadyReminded).toBe(1);
    expect(result.reminded).toBe(0);
    expect(email.sent.length).toBe(0);
    expect(notifier.notifications.length).toBe(0);
  });

  it("KEEPS the claim when one channel fails and the other succeeds", async () => {
    // Deliberate: the next hourly pass must not re-send over the channel that already
    // worked. One member told once beats one member told 72 times.
    const email = new FakeEmailAdapter();
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    notifier.failNextNotify = true;
    const { port: reminders, rows } = fakeReminders();
    const errors: string[] = [];
    const subscriptions = [subscriptionRow()];
    const useCase = build({
      subscriptions: fakeSubscriptions([subscriptions, subscriptions]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier,
      logError: (line) => errors.push(line),
    });

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.reminded).toBe(1);
    expect(rows.get("sub-1")?.channels).toBe("email");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("whatsapp");
    // The second pass finds the claim spent and sends nothing at all.
    expect(second.alreadyReminded).toBe(1);
    expect(email.sent.length).toBe(1);
  });

  it("KEEPS the claim when the member WAS told and only the bookkeeping afterwards failed", async () => {
    // The narrow case the release guard actually exists for. A partial channel
    // failure never reaches the release path at all — each channel has its own
    // try/catch — so the only way to arrive there holding a delivered message is for
    // something AFTER the sends to throw. Releasing then would hand the membership
    // back to the next pass an hour later and re-send to a member who already has it.
    const email = new FakeEmailAdapter();
    const { port: inner, rows } = fakeReminders();
    const reminders: MembershipReminderRepositoryPort = {
      claim: inner.claim,
      async recordOutcome() {
        throw new Error("the audit write failed");
      },
      release: inner.release,
      findBySubscriptionId: inner.findBySubscriptionId,
    };
    const subscriptions = [subscriptionRow()];
    const useCase = build({
      subscriptions: fakeSubscriptions([subscriptions, subscriptions]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier: null,
      logError: () => undefined,
    });

    const first = await useCase.execute();
    expect(first.failed).toBe(1);
    // The claim survives, so the second pass sends nothing.
    expect(rows.get("sub-1")).toBeDefined();
    const second = await useCase.execute();
    expect(second.alreadyReminded).toBe(1);
    expect(email.sent.length).toBe(1);
  });

  it("RELEASES the claim when every available channel fails, so the next pass retries", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    notifier.failNextNotify = true;
    const { port: reminders, rows } = fakeReminders();
    const errors: string[] = [];
    const subscriptions = [subscriptionRow()];
    const useCase = build({
      subscriptions: fakeSubscriptions([subscriptions, subscriptions]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email: null,
      notifier,
      logError: (line) => errors.push(line),
    });

    const first = await useCase.execute();
    expect(first.reminded).toBe(0);
    expect(first.failed).toBe(1);
    // Nothing reached the member, so the claim is given back rather than swallowing
    // the reminder for ever.
    expect(rows.get("sub-1")).toBeUndefined();

    const second = await useCase.execute();
    expect(second.reminded).toBe(1);
    expect(notifier.notifications.length).toBe(1);
  });

  it("asks only for memberships ending inside the three-day lead, and never for ones already lapsed", async () => {
    const { repository, calls } = fakeSubscriptions([[]]);
    const useCase = build({
      subscriptions: repository,
      users: fakeUsers([]),
      reminders: fakeReminders().port,
      email: new FakeEmailAdapter(),
      notifier: null,
    });

    await useCase.execute();

    expect(calls.length).toBe(1);
    // EXCLUSIVE lower bound at `now`: a membership already past its end belongs to
    // the retirement sweep, not to a warning about something that already happened.
    expect(calls[0].from).toEqual(NOW);
    expect(calls[0].to).toEqual(new Date("2026-08-24T00:00:00.000Z"));
  });

  it("PAGES through the backlog, because a reminded membership stays in the result set", async () => {
    const email = new FakeEmailAdapter();
    const first = subscriptionRow({ id: "sub-1" });
    const second = subscriptionRow({
      id: "sub-2",
      currentPeriodEnd: new Date("2026-08-23T06:00:00.000Z"),
    });
    const { repository, calls } = fakeSubscriptions([[first], [second], []]);
    const useCase = build({
      subscriptions: repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders: fakeReminders().port,
      email,
      notifier: null,
      batchSize: 1,
    });

    const result = await useCase.execute();

    // A per-pass cap of one would have reminded `sub-1` for ever and never reached
    // `sub-2` — the defect `ProcessRenewals` measured with the same batch size.
    expect(result.reminded).toBe(2);
    expect(email.sent.length).toBe(2);
    expect(calls[1].after).toEqual({ currentPeriodEnd: first.currentPeriodEnd!, id: "sub-1" });
  });

  it("does not let one membership's failure abort the rest of the pass", async () => {
    const email = new FakeEmailAdapter();
    const errors: string[] = [];
    const { port: inner } = fakeReminders();
    const reminders: MembershipReminderRepositoryPort = {
      async claim(id) {
        if (id === "sub-1") throw new Error("claim exploded");
        return inner.claim(id);
      },
      recordOutcome: inner.recordOutcome,
      release: inner.release,
      findBySubscriptionId: inner.findBySubscriptionId,
    };
    const useCase = build({
      subscriptions: fakeSubscriptions([
        [subscriptionRow({ id: "sub-1" }), subscriptionRow({ id: "sub-2" })],
      ]).repository,
      users: fakeUsers([subscriberRow(), ownerRow()]),
      reminders,
      email,
      notifier: null,
      logError: (line) => errors.push(line),
    });

    const result = await useCase.execute();

    expect(result.failed).toBe(1);
    expect(result.reminded).toBe(1);
    expect(email.sent.length).toBe(1);
    expect(errors.length).toBe(1);
  });
});
