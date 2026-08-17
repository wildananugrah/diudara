import { describe, expect, it } from "bun:test";
import { RequestPasswordReset } from "./request-password-reset";
import { hashResetToken } from "../../domain/reset-token";
import { FakeEmailAdapter } from "../../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import type { ClockPort } from "../ports/clock.port";
import type { PasswordResetRepositoryPort, PasswordResetTokenRecord } from "../ports/password-reset-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: null,
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeUserRepository(seed: UserRecord[] = []): UserRepositoryPort {
  const rows = [...seed];
  return {
    async create() {
      throw new Error("not used in these tests");
    },
    async findByHandle(handle) {
      return rows.find((r) => r.handle === handle) ?? null;
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail(email) {
      return rows.find((r) => r.email === email) ?? null;
    },
    async findCredentialsByEmail() {
      throw new Error("not used in these tests");
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
  };
}

interface FakeRow extends PasswordResetTokenRecord {
  requestIpHash: string | null;
}

/**
 * In-memory `PasswordResetRepositoryPort`, tracking `requestIpHash`
 * internally for the IP count. `createdAt` is stamped from `now()` — the
 * SAME clock the use-case under test is given — rather than the real wall
 * clock: the rate-limit window is measured relative to `ClockPort`, and a
 * fake that used real time here would make the window comparison drift
 * from whatever fixed instant a test's `ClockPort` fake reports.
 */
function fakePasswordResetRepository(now: () => Date = () => new Date()) {
  const rows: FakeRow[] = [];
  let counter = 0;
  const repo: PasswordResetRepositoryPort = {
    async create(input) {
      counter += 1;
      const row: FakeRow = {
        id: `token-${counter}`,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: now(),
        requestIpHash: input.requestIpHash,
      };
      rows.push(row);
      return row;
    },
    async findByHash(tokenHash) {
      return rows.find((r) => r.tokenHash === tokenHash) ?? null;
    },
    async countForUserSince(userId, since) {
      return rows.filter((r) => r.userId === userId && r.createdAt >= since).length;
    },
    async countForIpSince(ipHash, since) {
      return rows.filter((r) => r.requestIpHash === ipHash && r.createdAt >= since).length;
    },
    async markUsed(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.usedAt !== null) return false;
      row.usedAt = new Date();
      return true;
    },
    async markAllOtherOutstandingUsed(userId, exceptId) {
      let affected = 0;
      for (const row of rows) {
        if (row.userId === userId && row.id !== exceptId && row.usedAt === null) {
          row.usedAt = new Date();
          affected += 1;
        }
      }
      return affected;
    },
  };
  return { repo, rows };
}

const NOW = new Date("2026-08-17T10:00:00.000Z");
const fixedClock: ClockPort = { now: () => new Date(NOW.getTime()) };
const CONFIG = { appBaseUrl: "https://app.diudara.test" };

function harness(options: {
  users?: UserRecord[];
  email?: FakeEmailAdapter | null;
  notifier?: FakeMessagingAdapter;
  clock?: ClockPort;
} = {}) {
  const users = fakeUserRepository(options.users ?? [record()]);
  const clock = options.clock ?? fixedClock;
  const { repo: passwordResets, rows } = fakePasswordResetRepository(() => clock.now());
  const email = options.email === undefined ? new FakeEmailAdapter() : options.email;
  const notifier = options.notifier ?? new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  const useCase = new RequestPasswordReset(users, passwordResets, email, notifier, clock, CONFIG);
  return { useCase, users, passwordResets, rows, email, notifier };
}

describe("RequestPasswordReset", () => {
  it("returns { ok: true } and sends nothing for an unknown email", async () => {
    const { useCase, email, notifier, rows } = harness({ users: [] });

    const result = await useCase.execute({ email: "nobody@example.com", ip: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
    expect((email as FakeEmailAdapter).sent).toHaveLength(0);
    expect(notifier.notifications).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("sends exactly one email when the email provider is configured", async () => {
    const { useCase, email, notifier, rows } = harness();

    const result = await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
    expect((email as FakeEmailAdapter).sent[0].to).toBe("wildan@example.com");
    expect(notifier.notifications).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it("stores only the token's HASH, and the stored hash matches hashResetToken() of the token actually sent — the plaintext appears nowhere in the row", async () => {
    const { useCase, email, rows } = harness();

    await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    const body = (email as FakeEmailAdapter).sent[0].body;
    const match = /\/reset\/([0-9a-f]{64})/.exec(body);
    expect(match).not.toBeNull();
    const sentToken = match?.[1] as string;

    expect(rows[0].tokenHash).toBe(hashResetToken(sentToken));
    expect(rows[0].tokenHash).not.toBe(sentToken);
    expect(JSON.stringify(rows[0])).not.toContain(sentToken);
  });

  it("falls back to WhatsApp when no email provider is configured and the user has a number", async () => {
    const { useCase, email, notifier } = harness({
      users: [record({ whatsappNumber: "+6281234567890" })],
      email: null,
    });

    const result = await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0].toWhatsappNumber).toBe("+6281234567890");
    expect((email as FakeEmailAdapter | null)?.sent ?? []).toHaveLength(0);
  });

  it("prefers email over WhatsApp when both are available", async () => {
    const { useCase, email, notifier } = harness({
      users: [record({ whatsappNumber: "+6281234567890" })],
    });

    await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
    expect(notifier.notifications).toHaveLength(0);
  });

  it("sends nothing, but still returns { ok: true }, when there is no email provider and no WhatsApp number", async () => {
    const { useCase, email, notifier, rows } = harness({ email: null });

    const result = await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
    expect((email as FakeEmailAdapter | null)?.sent ?? []).toHaveLength(0);
    expect(notifier.notifications).toHaveLength(0);
    // No channel available means nothing is recorded either.
    expect(rows).toHaveLength(0);
  });

  it("refuses after 3 requests for the same user within the hour, returning the SAME { ok: true } and sending nothing more", async () => {
    const { useCase, email, rows } = harness();

    await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    expect(rows).toHaveLength(3);

    const fourth = await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(fourth).toEqual({ ok: true });
    expect(rows).toHaveLength(3);
    expect((email as FakeEmailAdapter).sent).toHaveLength(3);
  });

  it("refuses after 10 requests from the same IP within the hour, across different accounts, returning the SAME shape", async () => {
    const users = Array.from({ length: 11 }, (_, i) =>
      record({ id: `user-${i}`, handle: `user${i}`, email: `user${i}@example.com` })
    );
    const { useCase, rows } = harness({ users });

    for (let i = 0; i < 10; i++) {
      const res = await useCase.execute({ email: `user${i}@example.com`, ip: "9.9.9.9" });
      expect(res).toEqual({ ok: true });
    }
    expect(rows).toHaveLength(10);

    const eleventh = await useCase.execute({ email: "user10@example.com", ip: "9.9.9.9" });
    expect(eleventh).toEqual({ ok: true });
    expect(rows).toHaveLength(10);
  });

  it("does not rate-limit across different IPs for the per-account limit boundary", async () => {
    const { useCase, rows } = harness();

    await useCase.execute({ email: "wildan@example.com", ip: "1.1.1.1" });
    await useCase.execute({ email: "wildan@example.com", ip: "2.2.2.2" });
    await useCase.execute({ email: "wildan@example.com", ip: "3.3.3.3" });

    // Still within the per-user cap of 3 even though the IP changed each time.
    expect(rows).toHaveLength(3);
  });

  it("normalises the email before lookup", async () => {
    const { useCase, email } = harness();

    const result = await useCase.execute({ email: "  WILDAN@Example.COM  ", ip: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
  });

  it("works with no client IP at all — the per-IP limit simply never triggers", async () => {
    const { useCase, email } = harness();

    const result = await useCase.execute({ email: "wildan@example.com", ip: null });

    expect(result).toEqual({ ok: true });
    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
  });

  it("swallows a send failure and still returns { ok: true } — a provider outage must not leak account existence", async () => {
    const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
    const email = new FakeEmailAdapter();
    email.send = async () => {
      throw new Error("fake provider outage");
    };
    const { useCase } = harness({ email, notifier });

    const result = await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(result).toEqual({ ok: true });
  });

  it("EVERY path returns the exact same shape — the enumeration-safety guarantee", async () => {
    const noUser = harness({ users: [] });
    const found = harness();
    const overLimit = harness();
    const noChannel = harness({ email: null });

    const r1 = await noUser.useCase.execute({ email: "nobody@example.com", ip: "1.2.3.4" });
    const r2 = await found.useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    await overLimit.useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    await overLimit.useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    await overLimit.useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    const r3 = await overLimit.useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });
    const r4 = await noChannel.useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(r3).toEqual({ ok: true });
    expect(r4).toEqual({ ok: true });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r3));
    expect(JSON.stringify(r3)).toBe(JSON.stringify(r4));
  });
});
