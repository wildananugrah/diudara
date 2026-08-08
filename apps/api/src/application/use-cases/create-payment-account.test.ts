import { describe, expect, it } from "bun:test";
import { CreatePaymentAccount } from "./create-payment-account";
import { ConflictError, NotFoundError } from "../errors";
import type { CreatorRecord, CreatorRepositoryPort } from "../ports/creator-repository.port";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";

function fakeRepository(seed: CreatorRecord[] = []) {
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
      const row = rows.find((r) => r.id === id);
      if (row) row.xenditAccountId = accountId;
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

  it("throws ConflictError, not a provider call with null, when the creator has no email", async () => {
    const { repository } = fakeRepository([creator({ email: null })]);
    const payments = new FakePaymentAdapter();
    const useCase = new CreatePaymentAccount(repository, payments);

    await expect(useCase.execute("creator-1")).rejects.toBeInstanceOf(ConflictError);
    expect(payments.accounts.length).toBe(0);
  });
});
