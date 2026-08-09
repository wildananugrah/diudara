import { describe, expect, it } from "bun:test";
import { CreatePaymentAccount } from "./create-payment-account";
import { ConflictError, NotFoundError } from "../errors";
import type { CreatorRecord, CreatorRepositoryPort } from "../ports/creator-repository.port";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";

/**
 * `onSetXenditAccountId` runs just before the claim is evaluated, which is the
 * only way to model a CONCURRENT caller against an in-memory repository: it
 * stands in for another request having filled the column while our provider
 * HTTP call was in flight.
 */
function fakeRepository(
  seed: CreatorRecord[] = [],
  hooks: { onSetXenditAccountId?: (rows: CreatorRecord[]) => void } = {}
) {
  const rows = [...seed];

  const repository: CreatorRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findByEmail() {
      throw new Error("not used in these tests");
    },
    async findCredentialsByEmail() {
      throw new Error("not used in these tests");
    },
    async setXenditAccountId(id, accountId) {
      hooks.onSetXenditAccountId?.(rows);
      // Mirrors the real repository's conditional UPDATE: the write only lands
      // when the column is still empty, and the boolean is the row count.
      const row = rows.find((r) => r.id === id);
      if (!row || row.xenditAccountId !== null) return false;
      row.xenditAccountId = accountId;
      return true;
    },
  };
  return { repository, rows };
}

function creator(overrides: Partial<CreatorRecord> = {}): CreatorRecord {
  return {
    id: "creator-1",
    name: "Budi",
    whatsappNumber: null,
    email: "budi@example.com",
    tierPlan: "starter",
    xenditAccountId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("CreatePaymentAccount", () => {
  it("connects a payment account and persists the id, using the CREATOR's identity", async () => {
    const { repository, rows } = fakeRepository([creator()]);
    const payments = new FakePaymentAdapter();
    const useCase = new CreatePaymentAccount(repository, payments);

    const result = await useCase.execute("creator-1");

    expect(result.xenditAccountId).toBeTruthy();
    expect(rows[0].xenditAccountId).toBe(result.xenditAccountId);
    expect(payments.accounts).toEqual([
      { creatorId: "creator-1", accountId: result.xenditAccountId },
    ]);
  });

  it("throws NotFoundError when the creator does not exist", async () => {
    const { repository } = fakeRepository([]);
    const useCase = new CreatePaymentAccount(repository, new FakePaymentAdapter());

    await expect(useCase.execute("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ConflictError when a payment account is already connected", async () => {
    const { repository } = fakeRepository([creator({ xenditAccountId: "already-connected" })]);
    const useCase = new CreatePaymentAccount(repository, new FakePaymentAdapter());

    await expect(useCase.execute("creator-1")).rejects.toBeInstanceOf(ConflictError);
  });

  // I4, final whole-branch review. findById -> check -> create provider account
  // -> UNCONDITIONAL update is a TOCTOU: probed at 5 concurrent requests with
  // one bearer token, all five returned 201 and the last writer won.
  it("409s instead of reporting success when a concurrent caller won the column", async () => {
    const { repository, rows } = fakeRepository([creator()], {
      onSetXenditAccountId(current) {
        // Another request finished while our provider call was in flight.
        current[0].xenditAccountId = "acct-from-the-other-request";
      },
    });
    const payments = new FakePaymentAdapter();
    const useCase = new CreatePaymentAccount(repository, payments);

    await expect(useCase.execute("creator-1")).rejects.toBeInstanceOf(ConflictError);
    // The whole point: the column still names the OTHER account, and this caller
    // was not told that its own account is where money will settle.
    expect(rows[0].xenditAccountId).toBe("acct-from-the-other-request");
  });

  it("names the orphaned provider account so it can be reconciled by hand", async () => {
    // Xendit MANAGED sub-accounts are KYC entities with no delete endpoint, so
    // the only remedy is an operator finding it. Ids only — never the email or
    // the business name.
    const { repository } = fakeRepository([creator()], {
      onSetXenditAccountId(current) {
        current[0].xenditAccountId = "acct-from-the-other-request";
      },
    });
    const payments = new FakePaymentAdapter();
    const useCase = new CreatePaymentAccount(repository, payments);

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      await useCase.execute("creator-1").catch(() => undefined);
    } finally {
      console.warn = original;
    }

    expect(warnings.some((line) => /orphaned provider account/.test(line))).toBe(true);
    expect(warnings.some((line) => line.includes(payments.accounts[0].accountId))).toBe(true);
    expect(warnings.join("\n")).not.toContain("budi@example.com");
    expect(warnings.join("\n")).not.toContain("Budi");
  });

  it("throws ConflictError, not a provider call with null, when the creator has no email", async () => {
    const { repository } = fakeRepository([creator({ email: null })]);
    const payments = new FakePaymentAdapter();
    const useCase = new CreatePaymentAccount(repository, payments);

    await expect(useCase.execute("creator-1")).rejects.toBeInstanceOf(ConflictError);
    expect(payments.accounts.length).toBe(0);
  });
});
