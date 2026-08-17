import { describe, expect, it } from "bun:test";
import { EXISTING_EMAIL_SIGNUP_NOTICE, RegisterUser } from "./register-user";
import { ConflictError, UniqueRule, UniqueViolationError, ValidationError } from "../errors";
import { FakeEmailAdapter } from "../../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../../infrastructure/messaging/fake-messaging.adapter";
import type { ClockPort } from "../ports/clock.port";
import type { SignupNoticeRepositoryPort } from "../ports/signup-notice-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { PasswordHasherPort } from "../ports/password-hasher.port";

/**
 * A manually-released gate for deterministically proving `execute()`
 * resolves BEFORE a fire-and-forget notice send completes — review finding
 * NF1. No sleeps: held open until the test calls `release()`.
 */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Drains pending microtasks/one macrotask turn — see the identical helper in request-password-reset.test.ts. */
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

/**
 * A fake that mirrors `DrizzleUserRepository.create`'s behaviour: it raises
 * `UniqueViolationError` on a colliding handle OR email, exactly like the
 * real unique index does, rather than silently allowing two rows for one
 * logical handle/email.
 */
function fakeRepository(seed: UserRecord[] = []) {
  const rows = [...seed];
  const hashes = new Map<string, string>();

  const repository: UserRepositoryPort = {
    async create(input) {
      if (rows.some((r) => r.handle === input.handle)) {
        throw new UniqueViolationError(UniqueRule.userHandle, "handle is already taken");
      }
      if (rows.some((r) => r.email === input.email)) {
        throw new UniqueViolationError(UniqueRule.userEmail, "email is already registered");
      }
      const row: UserRecord = {
        id: `user-${rows.length + 1}`,
        handle: input.handle,
        email: input.email,
        whatsappNumber: input.whatsappNumber,
        displayName: input.displayName,
        bio: null,
        sessionEpoch: 0,
        createdAt: new Date(),
      };
      rows.push(row);
      hashes.set(row.id, input.passwordHash);
      return row;
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
    async findCredentialsByEmail(email) {
      const row = rows.find((r) => r.email === email);
      if (!row) return null;
      return { id: row.id, passwordHash: hashes.get(row.id) as string, sessionEpoch: row.sessionEpoch };
    },
    async updateProfile() {
      throw new Error("not used in these tests");
    },
    async setPasswordAndBumpEpoch() {
      throw new Error("not used in these tests");
    },
  };
  return { repository, rows, hashes };
}

const fakeHasher: PasswordHasherPort = {
  async hash(plain) {
    return `hashed:${plain}`;
  },
  async verify(plain, hash) {
    return hash === `hashed:${plain}`;
  },
};

function fakeHasherWithCallCount(): { hasher: PasswordHasherPort; callCount: () => number } {
  let hashCalls = 0;
  const hasher: PasswordHasherPort = {
    async hash(plain) {
      hashCalls++;
      return `hashed:${plain}`;
    },
    async verify(plain, hash) {
      return hash === `hashed:${plain}`;
    },
  };
  return { hasher, callCount: () => hashCalls };
}

const FIXED_NOW = new Date("2026-08-17T10:00:00.000Z");
const fixedClock: ClockPort = { now: () => new Date(FIXED_NOW.getTime()) };

/**
 * In-memory `SignupNoticeRepositoryPort` — review finding F3's rate-limit
 * ledger. `createdAt` is stamped from an injectable `now()` rather than the
 * real wall clock, the same fix `request-password-reset.test.ts`'s own
 * fake needed: the window is measured against `ClockPort`, and a fake using
 * real time would drift from whatever fixed instant a test's clock reports.
 */
function fakeSignupNoticeRepository(now: () => Date = () => new Date()) {
  const rows: { userId: string; createdAt: Date }[] = [];
  const repo: SignupNoticeRepositoryPort = {
    async countForUserSince(userId, since) {
      return rows.filter((r) => r.userId === userId && r.createdAt >= since).length;
    },
    async record(userId) {
      rows.push({ userId, createdAt: now() });
    },
  };
  return { repo, rows };
}

/**
 * Builds a `RegisterUser` with Task 5's new collaborators defaulted to "no
 * channel available, never rate-limited" (`email: null`, a throwaway
 * `FakeMessagingAdapter`, a fresh `SignupNoticeRepositoryPort`, a fixed
 * clock) — every test above this helper's introduction predates the
 * existing-email notice and pairs `VALID` (no `whatsappNumber`) with a
 * fresh handle, so none of them ever reaches a duplicate-email branch that
 * would try to notify anyone. The notice itself is exercised by its own
 * dedicated tests below, which pass `email`/`notifier`/`signupNotices`
 * explicitly.
 */
function buildUseCase(
  repository: UserRepositoryPort,
  hasher: PasswordHasherPort = fakeHasher,
  email: FakeEmailAdapter | null = null,
  notifier: FakeMessagingAdapter = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false }),
  signupNotices: SignupNoticeRepositoryPort = fakeSignupNoticeRepository().repo,
  clock: ClockPort = fixedClock
): RegisterUser {
  return new RegisterUser(repository, hasher, email, notifier, signupNotices, clock);
}

const VALID = {
  handle: "wildan",
  email: "wildan@example.com",
  password: "supersecret123",
  displayName: "Wildan",
};

describe("RegisterUser", () => {
  it("creates a user with a hashed password", async () => {
    const { repository, rows, hashes } = fakeRepository();
    const useCase = buildUseCase(repository);

    const result = await useCase.execute(VALID);

    expect(result).toEqual({ ok: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe("wildan");
    expect(rows[0].displayName).toBe("Wildan");
    expect(hashes.get(rows[0].id)).toBe("hashed:supersecret123");
  });

  it("passes displayName through to the repository unchanged", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = buildUseCase(repository);

    await useCase.execute({ ...VALID, displayName: "Wildan Anugrah" });

    expect(rows[0].displayName).toBe("Wildan Anugrah");
  });

  it("passes a provided whatsappNumber through to the repository unchanged", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = buildUseCase(repository);

    await useCase.execute({ ...VALID, whatsappNumber: "+6281234567890" });

    expect(rows[0].whatsappNumber).toBe("+6281234567890");
  });

  it("stores whatsappNumber as null when none is provided", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = buildUseCase(repository);

    await useCase.execute(VALID);

    expect(rows[0].whatsappNumber).toBeNull();
  });

  it("normalises the handle before storing it, stripping a leading @ and lowercasing", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = buildUseCase(repository);

    await useCase.execute({ ...VALID, handle: "  @Wildan  " });

    expect(rows[0].handle).toBe("wildan");
  });

  it("normalises the email before storing it", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = buildUseCase(repository);

    await useCase.execute({ ...VALID, email: "  Wildan@Example.COM " });

    expect(rows[0].email).toBe("wildan@example.com");
  });

  it("rejects a handle that fails domain validation after normalisation", async () => {
    const { repository } = fakeRepository();
    const useCase = buildUseCase(repository);

    await expect(useCase.execute({ ...VALID, handle: "ab" })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("THE CENTRAL GUARANTEE: '@Wildan' and 'wildan' collide as the same handle", async () => {
    const { repository, rows } = fakeRepository();
    const useCase = buildUseCase(repository);

    await useCase.execute({ ...VALID, handle: "@Wildan", email: "first@example.com" });
    await expect(
      useCase.execute({ ...VALID, handle: "wildan", email: "second@example.com" })
    ).rejects.toBeInstanceOf(ConflictError);

    // Exactly one row exists for the logical identity, not two.
    expect(rows).toHaveLength(1);
  });

  it("rejects a duplicate handle with ConflictError (409) — handles are public, this is safe to reveal", async () => {
    const { repository } = fakeRepository([record({ handle: "wildan", email: "someone@example.com" })]);
    const useCase = buildUseCase(repository);

    await expect(
      useCase.execute({ ...VALID, handle: "wildan", email: "new@example.com" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("REGRESSION (critical): a taken handle 409s even when the email in the same request is ALSO already registered", async () => {
    // The bug this pins: an earlier version checked email BEFORE handle and
    // returned `{ ok: true }` on a hit, so `create()` — and with it the
    // handle-uniqueness check — never ran when the email was already
    // registered. A taken handle then 409'd ONLY when paired with a FREE
    // email, and silently answered success when paired with a REGISTERED
    // one. Since handles are public, that turned "is this handle taken"
    // into "does this email have an account" — the exact oracle this class
    // exists to prevent — discoverable with one known handle and a guessed
    // email, no setup required. Every OTHER duplicate-email test in this
    // file pairs it with a FREE handle, which is precisely the one
    // combination that already answered identically; this is the one
    // combination that didn't.
    const { repository, rows } = fakeRepository([
      record({ handle: "taken", email: "registered@example.com" }),
    ]);
    const useCase = buildUseCase(repository);

    await expect(
      useCase.execute({ ...VALID, handle: "taken", email: "registered@example.com" })
    ).rejects.toBeInstanceOf(ConflictError);

    // No second row, and the existing one is untouched.
    expect(rows).toHaveLength(1);
  });

  it("returns success-shaped output for a duplicate email, rather than throwing — enumeration safety", async () => {
    const { repository, rows } = fakeRepository([
      record({ handle: "existing", email: "wildan@example.com" }),
    ]);
    const useCase = buildUseCase(repository);

    const result = await useCase.execute({ ...VALID, handle: "newhandle" });

    expect(result).toEqual({ ok: true });
    // No new row was created for the duplicate email.
    expect(rows).toHaveLength(1);
  });

  it("returns the identical shape for a fresh signup and a duplicate email", async () => {
    const { repository } = fakeRepository([
      record({ handle: "existing", email: "wildan@example.com" }),
    ]);
    const useCase = buildUseCase(repository);

    const fresh = await useCase.execute({ ...VALID, handle: "freshone", email: "fresh@example.com" });
    const duplicate = await useCase.execute({ ...VALID, handle: "anotherone" });

    expect(fresh).toEqual(duplicate);
  });

  it("hashes the password even on the duplicate-email path, so response time is not an oracle", async () => {
    const { hasher, callCount } = fakeHasherWithCallCount();
    const { repository } = fakeRepository([
      record({ handle: "existing", email: "wildan@example.com" }),
    ]);
    const useCase = buildUseCase(repository, hasher);

    await useCase.execute(VALID);

    expect(callCount()).toBe(1);
  });

  it("still answers { ok: true } when a race loses to a concurrent signup with the same email", async () => {
    // The pre-check (`findByEmail`) can pass for two concurrent callers; the
    // database's unique index is the real arbiter. This drives the use-case
    // through the `create()`-throws-UniqueViolationError(userEmail) branch
    // directly, rather than the pre-check branch above.
    const { repository, rows } = fakeRepository();
    const originalCreate = repository.create.bind(repository);
    repository.create = async (input) => {
      if (input.email === "racer@example.com") {
        throw new UniqueViolationError(UniqueRule.userEmail, "email is already registered");
      }
      return originalCreate(input);
    };
    const useCase = buildUseCase(repository);

    const result = await useCase.execute({ ...VALID, email: "racer@example.com" });

    expect(result).toEqual({ ok: true });
    expect(rows).toHaveLength(0);
  });

  describe("Task 5: the existing-email signup notice", () => {
    it("sends exactly ONE message to the existing account's channel, and the HTTP-facing result stays byte-identical to a fresh signup's", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: null }),
      ]);
      const email = new FakeEmailAdapter();
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, email, notifier);

      const duplicate = await useCase.execute({ ...VALID, handle: "newhandle" });

      expect(email.sent).toHaveLength(1);
      expect(email.sent[0].to).toBe("wildan@example.com");
      expect(email.sent[0].body).toBe(EXISTING_EMAIL_SIGNUP_NOTICE);
      expect(notifier.notifications).toHaveLength(0);

      // Byte-identical to a fresh signup's result — same repository instance,
      // fresh email, no channel fakes needed since nothing is sent on this path.
      const fresh = await useCase.execute({ ...VALID, handle: "freshone", email: "fresh@example.com" });
      expect(JSON.stringify(duplicate)).toBe(JSON.stringify(fresh));
      expect(duplicate).toEqual({ ok: true });
    });

    it("falls back to WhatsApp when no email provider is configured and the existing owner has a number", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: "+6281234567890" }),
      ]);
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, null, notifier);

      await useCase.execute({ ...VALID, handle: "newhandle" });

      expect(notifier.notifications).toHaveLength(1);
      expect(notifier.notifications[0].toWhatsappNumber).toBe("+6281234567890");
      expect(notifier.notifications[0].message).toBe(EXISTING_EMAIL_SIGNUP_NOTICE);
    });

    it("prefers email over WhatsApp when the existing owner has both available", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: "+6281234567890" }),
      ]);
      const email = new FakeEmailAdapter();
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, email, notifier);

      await useCase.execute({ ...VALID, handle: "newhandle" });

      expect(email.sent).toHaveLength(1);
      expect(notifier.notifications).toHaveLength(0);
    });

    it("sends nothing, but still returns { ok: true }, when the existing owner has no channel at all", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: null }),
      ]);
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, null, notifier);

      const result = await useCase.execute({ ...VALID, handle: "newhandle" });

      expect(result).toEqual({ ok: true });
      expect(notifier.notifications).toHaveLength(0);
    });

    it("never notifies anyone on a FRESH signup — there is no existing owner to tell", async () => {
      const { repository } = fakeRepository();
      const email = new FakeEmailAdapter();
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, email, notifier);

      await useCase.execute(VALID);

      expect(email.sent).toHaveLength(0);
      expect(notifier.notifications).toHaveLength(0);
    });

    it("swallows a send failure and still returns { ok: true } — a provider outage must not turn a duplicate-email signup into a 500", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: null }),
      ]);
      const email = new FakeEmailAdapter();
      email.send = async () => {
        throw new Error("fake provider outage");
      };
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, email, notifier);

      const result = await useCase.execute({ ...VALID, handle: "newhandle" });

      expect(result).toEqual({ ok: true });
    });

    /**
     * Review finding F3: an unrate-limited notice let 25 signup attempts
     * against one address deliver 25 messages. Capped at 3/hour/account, in
     * its own ledger — the 4th attempt against the SAME existing account
     * within the window must record no further notice and send nothing
     * more, while still answering { ok: true }.
     */
    it("caps the notice at 3 per hour per account, and stays silent (but still { ok: true }) past the cap", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: null }),
      ]);
      const email = new FakeEmailAdapter();
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const { repo: signupNotices, rows: noticeRows } = fakeSignupNoticeRepository(() => fixedClock.now());
      const useCase = buildUseCase(repository, fakeHasher, email, notifier, signupNotices, fixedClock);

      for (let i = 0; i < 3; i++) {
        const res = await useCase.execute({ ...VALID, handle: `attempt${i}` });
        expect(res).toEqual({ ok: true });
      }
      expect(email.sent).toHaveLength(3);
      expect(noticeRows).toHaveLength(3);

      const fourth = await useCase.execute({ ...VALID, handle: "attempt4" });

      expect(fourth).toEqual({ ok: true });
      expect(email.sent).toHaveLength(3);
      expect(noticeRows).toHaveLength(3);
    });

    /**
     * Review finding (minor): the concurrent-race branch's own notification
     * path was untested — only the `{ ok: true }` / no-second-row outcome
     * was. This drives `create()` into the SAME `UniqueViolationError`
     * (userEmail) branch the pre-existing race test above does, but this
     * time against a repository that HAS a matching existing row, so
     * `maybeNotifyExistingOwner` actually has an owner to notify.
     */
    it("notifies the owner on the CONCURRENT-RACE branch too, not just the pre-check branch", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "racer@example.com", whatsappNumber: null }),
      ]);
      const originalCreate = repository.create.bind(repository);
      repository.create = async (input) => {
        if (input.email === "racer@example.com") {
          throw new UniqueViolationError(UniqueRule.userEmail, "email is already registered");
        }
        return originalCreate(input);
      };
      const email = new FakeEmailAdapter();
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, email, notifier);

      const result = await useCase.execute({ ...VALID, handle: "newhandle", email: "racer@example.com" });

      expect(result).toEqual({ ok: true });
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0].to).toBe("racer@example.com");
      expect(email.sent[0].body).toBe(EXISTING_EMAIL_SIGNUP_NOTICE);
    });

    /**
     * Review finding NF1: F2's fix (not awaiting the notice send) was
     * unpinned — re-adding `await` in front of
     * `this.notifyExistingOwner(existing)` survived every other test, since
     * none of them check that `execute()` returned before the message
     * arrived, only that it eventually did.
     *
     * Deterministic, no sleeps: the email adapter's `send` blocks on a gate
     * this test controls directly.
     */
    it("resolves BEFORE the notice send completes — the fire-and-forget guarantee (NF1)", async () => {
      const { repository } = fakeRepository([
        record({ handle: "existing", email: "wildan@example.com", whatsappNumber: null }),
      ]);
      const { gate, release } = makeGate();
      const email = new FakeEmailAdapter();
      const originalSend = email.send.bind(email);
      email.send = async (input) => {
        await gate;
        await originalSend(input);
      };
      const notifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
      const useCase = buildUseCase(repository, fakeHasher, email, notifier);

      const result = await useCase.execute({ ...VALID, handle: "newhandle" });

      // execute() already resolved — the gated send has not, so nothing has
      // arrived yet. If the send were awaited, this line would not be
      // reached until AFTER release() below, and this would find one sent
      // message instead of zero.
      expect(result).toEqual({ ok: true });
      expect(email.sent).toHaveLength(0);

      release();
      await flush();

      expect(email.sent).toHaveLength(1);
      expect(email.sent[0].to).toBe("wildan@example.com");
    });
  });
});
