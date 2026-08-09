import { describe, expect, it } from "bun:test";
import { CreatePaymentAccount } from "./create-payment-account";
import { ConflictError, NotFoundError } from "../errors";
import {
  XENDIT_ACCOUNT_PROVISIONING,
  isProvisioningPlaceholder,
} from "../../domain/payment-account";
import type { CreatorRecord, CreatorRepositoryPort } from "../ports/creator-repository.port";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";

/**
 * Each hook runs just BEFORE its conditional write is evaluated, which is the
 * only way to model a CONCURRENT caller against an in-memory repository: it
 * stands in for another request having reached the column while this one was
 * mid-flight.
 */
function fakeRepository(
  seed: CreatorRecord[] = [],
  hooks: {
    onBegin?: (rows: CreatorRecord[]) => void;
    onFinish?: (rows: CreatorRecord[]) => void;
    onAbandon?: (rows: CreatorRecord[]) => void;
  } = {}
) {
  const rows = [...seed];

  const repository: CreatorRepositoryPort = {
    async create() {
      throw new Error("not used in these tests");
    },
    async findById(id) {
      const row = rows.find((r) => r.id === id);
      // A copy, like a real query result: the use-case must not be able to see
      // later mutations through a reference it read earlier.
      return row ? { ...row } : null;
    },
    async findByEmail() {
      throw new Error("not used in these tests");
    },
    async findCredentialsByEmail() {
      throw new Error("not used in these tests");
    },
    // All three mirror the real repository's conditional UPDATEs: the write only
    // lands when the column is in the expected state, and the boolean is the
    // affected row count.
    async beginXenditAccountProvisioning(id) {
      hooks.onBegin?.(rows);
      const row = rows.find((r) => r.id === id);
      if (!row || row.xenditAccountId !== null) return false;
      row.xenditAccountId = XENDIT_ACCOUNT_PROVISIONING;
      return true;
    },
    async finishXenditAccountProvisioning(id, accountId) {
      hooks.onFinish?.(rows);
      const row = rows.find((r) => r.id === id);
      if (!row || !isProvisioningPlaceholder(row.xenditAccountId)) return false;
      row.xenditAccountId = accountId;
      return true;
    },
    async abandonXenditAccountProvisioning(id) {
      hooks.onAbandon?.(rows);
      const row = rows.find((r) => r.id === id);
      if (!row || !isProvisioningPlaceholder(row.xenditAccountId)) return false;
      row.xenditAccountId = null;
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
      onBegin(current) {
        // Another request claimed the column between our findById and our claim.
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

  /**
   * Task 7 item 1, the mechanism — DETERMINISTIC, unlike the concurrency probe in
   * routes/payment-account.test.ts.
   *
   * The claim is evaluated BEFORE the provider call, so a caller that loses it
   * must not have created anything at Xendit. Under Phase 3's order (provider
   * first, claim second) this array held one orphaned account per losing caller,
   * and orphans are permanent: MANAGED sub-accounts are KYC entities with no
   * delete endpoint. 30 concurrent requests produced 29 of them.
   */
  it("does not call the provider AT ALL when it loses the claim", async () => {
    const { repository } = fakeRepository([creator()], {
      onBegin(current) {
        current[0].xenditAccountId = "acct-from-the-other-request";
      },
    });
    const payments = new FakePaymentAdapter();
    const useCase = new CreatePaymentAccount(repository, payments);

    await expect(useCase.execute("creator-1")).rejects.toBeInstanceOf(ConflictError);

    expect(payments.accounts).toEqual([]);
  });

  it("claims the row with the sentinel BEFORE the provider is called", async () => {
    // Pins the ORDER, not just the outcome: the fake adapter reads the column at
    // the moment it is called, and it must already be claimed. Reversing the two
    // statements in the use-case makes this go red on its own.
    const { repository } = fakeRepository([creator()]);
    const payments = new FakePaymentAdapter();
    const seenAtProviderCall: (string | null)[] = [];
    const original = payments.createPaymentAccount.bind(payments);
    payments.createPaymentAccount = async (input) => {
      seenAtProviderCall.push(
        (await repository.findById(input.creatorId))?.xenditAccountId ?? null
      );
      return original(input);
    };

    await new CreatePaymentAccount(repository, payments).execute("creator-1");

    expect(seenAtProviderCall).toEqual([XENDIT_ACCOUNT_PROVISIONING]);
  });

  it("409s a request that arrives while another is still provisioning", async () => {
    // The sentinel is truthy, so this is the state StartCheckout must also refuse
    // (see start-checkout.test.ts). Here it must not become a second sub-account.
    const { repository } = fakeRepository([
      creator({ xenditAccountId: XENDIT_ACCOUNT_PROVISIONING }),
    ]);
    const payments = new FakePaymentAdapter();

    const error = await new CreatePaymentAccount(repository, payments)
      .execute("creator-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toContain("in progress");
    expect(payments.accounts).toEqual([]);
  });

  it("releases the claim when the provider call fails, so the creator can retry", async () => {
    // Without the release, one Xendit timeout would wedge this creator forever:
    // the sentinel blocks every later claim and there is no reset path for the
    // column.
    const { repository, rows } = fakeRepository([creator()]);
    const payments = new FakePaymentAdapter();
    payments.failNextPaymentAccount = true;

    await expect(
      new CreatePaymentAccount(repository, payments).execute("creator-1")
    ).rejects.toThrow(/createPaymentAccount failed/);
    expect(rows[0].xenditAccountId).toBeNull();

    // And the retry genuinely works, which is the property that matters.
    const result = await new CreatePaymentAccount(repository, payments).execute("creator-1");
    expect(result.xenditAccountId).toBe(rows[0].xenditAccountId!);
    expect(payments.accounts).toHaveLength(1);
  });

  it("names the orphaned provider account so it can be reconciled by hand", async () => {
    // Now only reachable if something overwrites the sentinel mid-flight (hand
    // edited SQL). Xendit MANAGED sub-accounts are KYC entities with no delete
    // endpoint, so the only remedy is an operator finding it. Ids only — never
    // the email or the business name.
    const { repository } = fakeRepository([creator()], {
      onFinish(current) {
        current[0].xenditAccountId = "acct-from-somewhere-else";
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
