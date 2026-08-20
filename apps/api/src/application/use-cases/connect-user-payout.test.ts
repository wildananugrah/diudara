import { describe, expect, it } from "bun:test";
import { ConnectUserPayout } from "./connect-user-payout";
import { GetUserPayoutStatus } from "./get-user-payout-status";
import { ConflictError, NotFoundError } from "../errors";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
import type {
  UserPayoutAccount,
  UserPayoutRepositoryPort,
} from "../ports/user-payout-repository.port";

/**
 * The sentinel as a LITERAL, never the imported constant: a test that compares
 * the code against itself would still pass if the value changed under it. The
 * value is `domain/payment-account.ts`'s, and the fake below models the real
 * conditional UPDATEs against it — see `drizzle-user-payout.repository.test.ts`
 * for the assertion that the real column actually holds this string.
 */
const SENTINEL = "provisioning:in-progress";

/**
 * In-memory `UserPayoutRepositoryPort`, mirroring the real one's conditional
 * UPDATEs: each write only lands when the column is in the expected state, and
 * the boolean is the affected row count. The check and the set happen in the
 * SAME synchronous turn, exactly as one SQL statement does — a fake that awaited
 * between them would model a database that cannot arbitrate anything.
 *
 * `onRead` runs inside `findPayoutAccount` and is how the concurrency test
 * builds a real interleaving; `onBegin`/`onFinish` run just BEFORE their
 * conditional write is evaluated and stand in for another request having reached
 * the column while this one was mid-flight.
 */
function fakeRepository(
  seed: UserPayoutAccount[] = [],
  hooks: {
    onRead?: () => Promise<void> | void;
    onBegin?: (rows: UserPayoutAccount[]) => void;
    onFinish?: (rows: UserPayoutAccount[]) => void;
  } = {}
) {
  const rows = seed.map((row) => ({ ...row }));

  const repository: UserPayoutRepositoryPort = {
    async findPayoutAccount(id) {
      await hooks.onRead?.();
      const row = rows.find((r) => r.id === id);
      // A copy, like a real query result: the use-case must not be able to see
      // later mutations through a reference it read earlier.
      return row ? { ...row } : null;
    },
    async beginXenditAccountProvisioning(id) {
      hooks.onBegin?.(rows);
      const row = rows.find((r) => r.id === id);
      if (!row || row.xenditAccountId !== null) return false;
      row.xenditAccountId = SENTINEL;
      return true;
    },
    async finishXenditAccountProvisioning(id, accountId) {
      hooks.onFinish?.(rows);
      const row = rows.find((r) => r.id === id);
      if (!row || row.xenditAccountId !== SENTINEL) return false;
      row.xenditAccountId = accountId;
      return true;
    },
    async abandonXenditAccountProvisioning(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.xenditAccountId !== SENTINEL) return false;
      row.xenditAccountId = null;
      return true;
    },
  };
  return { repository, rows };
}

function user(overrides: Partial<UserPayoutAccount> = {}): UserPayoutAccount {
  return {
    id: "user-1",
    email: "wildan@example.com",
    displayName: "Wildan",
    xenditAccountId: null,
    ...overrides,
  };
}

/** Captures what the provider was actually asked for, which the shared fake does not record. */
function recordAccountCalls(payments: FakePaymentAdapter) {
  const calls: { creatorId: string; email: string; name: string }[] = [];
  const original = payments.createPaymentAccount.bind(payments);
  payments.createPaymentAccount = async (input) => {
    calls.push(input);
    return original(input);
  };
  return calls;
}

describe("ConnectUserPayout", () => {
  it("connects a payout account and fills the column with the id the provider returned", async () => {
    const { repository, rows } = fakeRepository([user()]);
    const payments = new FakePaymentAdapter();

    const status = await new ConnectUserPayout(repository, payments).execute("user-1");

    expect(status).toEqual({ connected: true, provisioning: false });
    expect(payments.accounts).toHaveLength(1);
    expect(rows[0].xenditAccountId).toBe(payments.accounts[0].accountId);
  });

  it("sends the USER's own email and display name to the provider", async () => {
    const { repository } = fakeRepository([
      user({ email: "rina@example.com", displayName: "Rina Kusuma" }),
    ]);
    const payments = new FakePaymentAdapter();
    const calls = recordAccountCalls(payments);

    await new ConnectUserPayout(repository, payments).execute("user-1");

    // `creatorId` is `PaymentProviderPort`'s field name, carried over from the
    // creator flow and deliberately NOT renamed: renaming it would edit
    // `create-payment-account.ts`, which serves the untouchable /dashboard/*.
    // The value is this app_user's id — a different owner table, same provider.
    expect(calls).toEqual([
      { creatorId: "user-1", email: "rina@example.com", name: "Rina Kusuma" },
    ]);
  });

  it("throws NotFoundError when the user does not exist, and calls nobody", async () => {
    const { repository } = fakeRepository([]);
    const payments = new FakePaymentAdapter();

    const error = await new ConnectUserPayout(repository, payments)
      .execute("nope")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("user not found");
    expect(payments.accounts).toEqual([]);
  });

  it("is idempotent: connecting again returns connected without a second provider call", async () => {
    // Unlike the creator flow's 409, this route is safe to press twice — but the
    // one thing it must never do is provision a SECOND sub-account, since a
    // MANAGED sub-account is a KYC entity with no delete endpoint.
    const { repository, rows } = fakeRepository([user()]);
    const payments = new FakePaymentAdapter();
    const useCase = new ConnectUserPayout(repository, payments);

    const first = await useCase.execute("user-1");
    const second = await useCase.execute("user-1");

    expect(first).toEqual({ connected: true, provisioning: false });
    expect(second).toEqual({ connected: true, provisioning: false });
    expect(payments.accounts).toHaveLength(1);
    expect(rows[0].xenditAccountId).toBe(payments.accounts[0].accountId);
  });

  it("claims the row with the sentinel BEFORE the provider is called", async () => {
    // Pins the ORDER, not just the outcome: the provider fake reads the column at
    // the moment it is called, and it must ALREADY be claimed. Swapping the two
    // statements in the use-case makes this go red on its own — and that swap is
    // precisely the shape that orphaned 29 sub-accounts.
    const { repository } = fakeRepository([user()]);
    const payments = new FakePaymentAdapter();
    const seenAtProviderCall: (string | null)[] = [];
    const original = payments.createPaymentAccount.bind(payments);
    payments.createPaymentAccount = async (input) => {
      seenAtProviderCall.push(
        (await repository.findPayoutAccount(input.creatorId))?.xenditAccountId ?? null
      );
      return original(input);
    };

    await new ConnectUserPayout(repository, payments).execute("user-1");

    expect(seenAtProviderCall).toEqual([SENTINEL]);
  });

  /**
   * THE TEST THIS TASK EXISTS FOR. 30 genuinely concurrent connects, one
   * provider call.
   *
   * Measured on the creator flow before the sentinel: 30 concurrent requests
   * produced 30 Xendit sub-accounts, 29 of them unreferenced and permanent
   * (MANAGED sub-accounts are KYC entities with no delete endpoint); the same 30
   * requests SEQUENTIALLY produced 1. That is why this is `Promise.all` over 30
   * invocations and not a loop: a sequential version of this test passes against
   * the very defect the sentinel exists to prevent, which is how that defect
   * survived to production.
   *
   * The latch is what makes it evidence rather than hope (see `ArrivalLatch`): it
   * holds every caller at the read until all 30 have arrived, so all 30
   * demonstrably see an unclaimed column — the exact interleaving that minted the
   * orphans — and it REJECTS rather than resolving if they never all turn up.
   */
  it("30 concurrent connects produce exactly ONE provider call", async () => {
    const latch = new ArrivalLatch(30);
    const { repository, rows } = fakeRepository([user()], {
      onRead: () => latch.arriveAndWait(),
    });
    const payments = new FakePaymentAdapter();

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        new ConnectUserPayout(repository, payments).execute("user-1")
      )
    );

    expect(payments.accounts).toHaveLength(1);
    expect(rows[0].xenditAccountId).toBe(payments.accounts[0].accountId);
    // All 30 really did reach the read before any of them claimed the column.
    expect(latch.arrived).toBeGreaterThanOrEqual(30);
    // Nobody is told "connect failed": a loser either sees the winner's finished
    // connection or sees the claim still in flight. Neither is an error, and
    // neither created anything.
    for (const status of results) {
      expect(status.connected || status.provisioning).toBe(true);
    }
  });

  it("does not call the provider AT ALL when it loses the claim", async () => {
    // The deterministic sibling of the probe above: this one names the mechanism
    // rather than relying on 30 callers racing. A caller that loses the claim
    // must report the state it found, having created nothing.
    const { repository } = fakeRepository([user()], {
      onBegin(current) {
        // Another request claimed the column between our read and our claim.
        current[0].xenditAccountId = SENTINEL;
      },
    });
    const payments = new FakePaymentAdapter();

    const status = await new ConnectUserPayout(repository, payments).execute("user-1");

    expect(payments.accounts).toEqual([]);
    expect(status).toEqual({ connected: false, provisioning: true });
  });

  it("reports provisioning, not connected, when the column ALREADY holds the sentinel", async () => {
    // The state a second device lands in while the first is still mid-connect.
    // `if (user.xenditAccountId)` is TRUE here — the sentinel is a non-empty
    // string — so a truthiness check in the early "already connected" return
    // would answer `connected: true` for a user who cannot be paid at all, and
    // Task 6 would then hand `for_account_id: "provisioning:in-progress"` to
    // Xendit. It must fall through to the claim, lose it, and say so.
    const { repository, rows } = fakeRepository([user({ xenditAccountId: SENTINEL })]);
    const payments = new FakePaymentAdapter();

    const status = await new ConnectUserPayout(repository, payments).execute("user-1");

    expect(Boolean(rows[0].xenditAccountId)).toBe(true);
    expect(status).toEqual({ connected: false, provisioning: true });
    expect(payments.accounts).toEqual([]);
    expect(rows[0].xenditAccountId).toBe(SENTINEL);
  });

  it("reports the winner's connection to a loser that arrives after it finished", async () => {
    const { repository } = fakeRepository([user()], {
      onBegin(current) {
        current[0].xenditAccountId = "xnd-acct-from-the-other-request";
      },
    });
    const payments = new FakePaymentAdapter();

    const status = await new ConnectUserPayout(repository, payments).execute("user-1");

    expect(status).toEqual({ connected: true, provisioning: false });
    expect(payments.accounts).toEqual([]);
  });

  it("answers from a FRESH read, not the stale copy it started with", async () => {
    // Mutation-driven (the claim-first order survived swapping
    // `isConnectedPaymentAccount` for a truthiness check in the early return,
    // because `payoutStatusOf` still interpreted the value correctly). This is
    // what that early return actually buys: the read at the top is a COURTESY,
    // and the conditional UPDATE is the guard, so a caller that finds the
    // sentinel must still go to the database and report what it says NOW. Here
    // the other request finishes while this one is between its read and its
    // claim, and this caller must say "connected", not "still provisioning".
    const { repository } = fakeRepository([user({ xenditAccountId: SENTINEL })], {
      onBegin(current) {
        current[0].xenditAccountId = "xnd-acct-the-other-request-just-finished";
      },
    });
    const payments = new FakePaymentAdapter();

    const status = await new ConnectUserPayout(repository, payments).execute("user-1");

    expect(status).toEqual({ connected: true, provisioning: false });
    expect(payments.accounts).toEqual([]);
  });

  it("releases the claim when the provider call fails, so the user can retry", async () => {
    // Without the release, one provider timeout would wedge this user forever:
    // the sentinel blocks every later claim and there is no reset path for the
    // column.
    const { repository, rows } = fakeRepository([user()]);
    const payments = new FakePaymentAdapter();
    payments.failNextPaymentAccount = true;

    await expect(
      new ConnectUserPayout(repository, payments).execute("user-1")
    ).rejects.toThrow(/createPaymentAccount failed/);
    expect(rows[0].xenditAccountId).toBeNull();

    // And the retry genuinely works, which is the property that matters.
    const status = await new ConnectUserPayout(repository, payments).execute("user-1");
    expect(status).toEqual({ connected: true, provisioning: false });
    expect(payments.accounts).toHaveLength(1);
    expect(rows[0].xenditAccountId).toBe(payments.accounts[0].accountId);
  });

  it("names the orphaned provider account instead of reporting success, ids only", async () => {
    // Only reachable if something overwrites the sentinel mid-flight (hand-edited
    // SQL). The account we created is now unreferenced and cannot be deleted, so
    // the only remedy is an operator finding it — by id, never by email or name.
    const { repository } = fakeRepository([user()], {
      onFinish(current) {
        current[0].xenditAccountId = "xnd-acct-from-somewhere-else";
      },
    });
    const payments = new FakePaymentAdapter();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    let error: unknown;
    try {
      error = await new ConnectUserPayout(repository, payments)
        .execute("user-1")
        .catch((err: unknown) => err);
    } finally {
      console.warn = originalWarn;
    }

    expect(error).toBeInstanceOf(ConflictError);
    expect(warnings.some((line) => /orphaned provider account/.test(line))).toBe(true);
    expect(warnings.some((line) => line.includes(payments.accounts[0].accountId))).toBe(true);
    expect(warnings.join("\n")).not.toContain("wildan@example.com");
    expect(warnings.join("\n")).not.toContain("Wildan");
  });
});

describe("GetUserPayoutStatus", () => {
  it("reports neither connected nor provisioning for a fresh user", async () => {
    const { repository } = fakeRepository([user()]);

    expect(await new GetUserPayoutStatus(repository).execute("user-1")).toEqual({
      connected: false,
      provisioning: false,
    });
  });

  it("reports a REAL id as connected", async () => {
    const { repository } = fakeRepository([user({ xenditAccountId: "xnd-acct-real" })]);

    expect(await new GetUserPayoutStatus(repository).execute("user-1")).toEqual({
      connected: true,
      provisioning: false,
    });
  });

  it("reports the sentinel as NOT connected, even though the column is truthy", async () => {
    // THE BUG THIS FORECLOSES: `if (user.xenditAccountId)` is true here, and a
    // reader that trusted it would hand `for_account_id: "provisioning:in-progress"`
    // to the provider — charging a subscriber against an account that does not
    // exist. Every reader of this column goes through the predicates instead.
    const { repository, rows } = fakeRepository([user({ xenditAccountId: SENTINEL })]);

    const status = await new GetUserPayoutStatus(repository).execute("user-1");

    expect(Boolean(rows[0].xenditAccountId)).toBe(true);
    expect(status).toEqual({ connected: false, provisioning: true });
  });

  it("throws NotFoundError for a user that does not exist", async () => {
    const { repository } = fakeRepository([]);

    const error = await new GetUserPayoutStatus(repository)
      .execute("nope")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("user not found");
  });
});
