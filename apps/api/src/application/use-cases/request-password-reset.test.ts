import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { RequestPasswordReset } from "./request-password-reset";
import { hashResetToken } from "../../domain/reset-token";
import { FakeEmailAdapter } from "../../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import type { ClockPort } from "../ports/clock.port";
import type { PasswordResetRepositoryPort, PasswordResetTokenRecord } from "../ports/password-reset-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

/**
 * A manually-released gate for deterministically proving `execute()`
 * resolves BEFORE a fire-and-forget send completes — review finding NF1.
 * No sleeps: the send is held open until the test itself calls `release()`,
 * so there is no timing window to race and nothing to make flaky.
 */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/**
 * Drains pending microtasks (and one macrotask turn) so that whatever ran
 * as a continuation of a just-released gate has actually executed before
 * the next assertion — `await gate` alone only waits for the GATE promise
 * to settle, not for the `.then` continuations chained onto it elsewhere.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

  /**
   * Review finding F4: the per-IP cap was dropped — `X-Forwarded-For` is
   * client-supplied and this repository has no verified proxy config
   * overwriting it (see the class docstring). 15 different accounts from
   * ONE IP — more than the OLD cap of 10 — must all still succeed and send,
   * since only the PER-ACCOUNT limit (3/hour/account) is load-bearing now.
   */
  it("never limits by IP — 15 different accounts from the SAME IP all get sent to", async () => {
    const users = Array.from({ length: 15 }, (_, i) =>
      record({ id: `user-${i}`, handle: `user${i}`, email: `user${i}@example.com` })
    );
    const { useCase, email, rows } = harness({ users });

    for (let i = 0; i < 15; i++) {
      const res = await useCase.execute({ email: `user${i}@example.com`, ip: "9.9.9.9" });
      expect(res).toEqual({ ok: true });
    }

    expect(rows).toHaveLength(15);
    expect((email as FakeEmailAdapter).sent).toHaveLength(15);
  });

  /**
   * Review finding F4 (minor half): mutating the IP-hashing call to store
   * the raw IP instead must fail this test — the stored value is neither
   * the raw address nor the token's own hash, and independently recomputing
   * sha256(ip) must match it.
   */
  it("stores the request IP only as its sha256 hash, never raw", async () => {
    const { useCase, rows } = harness();

    await useCase.execute({ email: "wildan@example.com", ip: "203.0.113.42" });

    expect(rows).toHaveLength(1);
    const stored = rows[0].requestIpHash;
    expect(stored).not.toBeNull();
    expect(stored).not.toBe("203.0.113.42");
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(createHash("sha256").update("203.0.113.42").digest("hex"));
  });

  /**
   * Review finding F5 (the spec-clause failure): a token's `expiresAt` must
   * actually be 30 minutes from mint time — a HARDCODED literal, not a
   * re-import of `RESET_TOKEN_TTL_MS`, so a mutation that changes the
   * OFFSET USED HERE (e.g. to 30 days) without touching the constant's own
   * definition still fails this test. `RESET_TOKEN_TTL_MS`'s own value is
   * separately pinned in `domain/reset-token.test.ts`; this test pins that
   * `RequestPasswordReset` actually APPLIES it when writing the row.
   */
  it("mints a token that expires in exactly 30 minutes from now — pinned independently of the TTL constant", async () => {
    const { useCase, rows } = harness();

    await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    expect(rows).toHaveLength(1);
    const THIRTY_MINUTES_MS = 30 * 60 * 1000;
    expect(rows[0].expiresAt.getTime()).toBe(NOW.getTime() + THIRTY_MINUTES_MS);
    // Anything wildly different (a day, a month) would trip this bound too,
    // catching a mutation that used the right unit but the wrong magnitude.
    expect(rows[0].expiresAt.getTime() - NOW.getTime()).toBeLessThan(31 * 60 * 1000);
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

  it("works with no client IP at all — requestIpHash is simply null", async () => {
    const { useCase, email, rows } = harness();

    const result = await useCase.execute({ email: "wildan@example.com", ip: null });

    expect(result).toEqual({ ok: true });
    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
    expect(rows[0].requestIpHash).toBeNull();
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

  /**
   * Review finding NF1: F1's fix (not awaiting `send`) was unpinned —
   * re-adding `await` in front of `this.send(...)` survived the whole
   * suite, because every other test only checks that the message
   * EVENTUALLY arrives, never that `execute()` did not wait for it.
   *
   * Deterministic, no sleeps: the email adapter's `send` blocks on a gate
   * this test controls directly. `execute()` must resolve while the gate is
   * still held (proving it did not await the send); only after the test
   * releases the gate does the message actually land.
   */
  it("resolves BEFORE the send completes — the fire-and-forget guarantee (NF1)", async () => {
    const { gate, release } = makeGate();
    const email = new FakeEmailAdapter();
    const originalSend = email.send.bind(email);
    email.send = async (input) => {
      await gate;
      await originalSend(input);
    };
    const { useCase } = harness({ email });

    const result = await useCase.execute({ email: "wildan@example.com", ip: "1.2.3.4" });

    // execute() already resolved — the gated send has not, so nothing has
    // arrived yet. If `send` were awaited, this line would never be reached
    // until AFTER release() below, and this assertion would find one sent
    // message instead of zero.
    expect(result).toEqual({ ok: true });
    expect(email.sent).toHaveLength(0);

    release();
    await flush();

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe("wildan@example.com");
  });
});
