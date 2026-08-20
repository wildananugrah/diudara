import { describe, expect, it } from "bun:test";
import { StartUserSubscription } from "./start-user-subscription";
import { ConflictError, NotFoundError } from "../errors";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import type { UserTierRepositoryPort, UserTierRow } from "../ports/user-tier-repository.port";
import type {
  UserPayoutAccount,
  UserPayoutRepositoryPort,
} from "../ports/user-payout-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
  UserTransactionRow,
} from "../ports/user-subscription-repository.port";

/**
 * The sentinel as a LITERAL, never the imported constant — mirrors
 * `manage-user-tiers.test.ts` and `connect-user-payout.test.ts`. A test that
 * compared the code against itself would still pass if the value changed
 * under it, and this is the one value that must never reach the provider.
 */
const SENTINEL = "provisioning:in-progress";

/** The `external_id` prefix as a LITERAL, for the same reason. Task 7 routes on it. */
const PREFIX = "usub_";

const OWNER_ID = "owner-1";
const SUBSCRIBER_ID = "subscriber-1";
const OWNER_ACCOUNT = "xnd-acct-real";
const APP_BASE_URL = "https://diudara.test";
/** The instant every test in this file runs at, as a LITERAL. */
const NOW = new Date("2026-08-20T12:00:00.000Z");

function userRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: OWNER_ID,
    handle: "wildan",
    email: "wildan@example.com",
    whatsappNumber: "628123456789",
    displayName: "Wildan",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

function subscriberRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return userRecord({
    id: SUBSCRIBER_ID,
    handle: "rina",
    email: "rina@example.com",
    whatsappNumber: "628999888777",
    displayName: "Rina",
    ...overrides,
  });
}

/**
 * In-memory `UserRepositoryPort`. `StartUserSubscription` reads exactly two of
 * its methods — the owner by handle, the subscriber by id — and every other
 * method throws, so a use case that started writing to `app_user` (or
 * searching it) would fail loudly rather than silently.
 */
function fakeUserRepository(seed: UserRecord[]) {
  const rows = seed.map((row) => ({ ...row }));
  const unsupported = () => {
    throw new Error("StartUserSubscription must not touch app_user beyond reading it");
  };
  const repository: UserRepositoryPort = {
    create: unsupported,
    async findByHandle(handle) {
      const row = rows.find((r) => r.handle === handle);
      return row ? { ...row } : null;
    },
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
  };
  return repository;
}

function tierRow(overrides: Partial<UserTierRow> = {}): UserTierRow {
  return {
    id: "tier-1",
    ownerId: OWNER_ID,
    name: "Anggota",
    priceAmount: 50_000,
    billingCycle: "monthly",
    isActive: true,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

function fakeTierRepository(seed: UserTierRow[]) {
  const rows = seed.map((row) => ({ ...row }));
  const repository: UserTierRepositoryPort = {
    async create() {
      throw new Error("StartUserSubscription must never create a tier");
    },
    async findById(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async listByOwner(ownerId) {
      return rows.filter((r) => r.ownerId === ownerId).map((r) => ({ ...r }));
    },
    async listActiveByOwner(ownerId) {
      return rows.filter((r) => r.ownerId === ownerId && r.isActive).map((r) => ({ ...r }));
    },
    async deactivate() {
      throw new Error("StartUserSubscription must never deactivate a tier");
    },
  };
  return repository;
}

function payoutAccount(overrides: Partial<UserPayoutAccount> = {}): UserPayoutAccount {
  return {
    id: OWNER_ID,
    email: "wildan@example.com",
    displayName: "Wildan",
    xenditAccountId: OWNER_ACCOUNT,
    ...overrides,
  };
}

/**
 * In-memory `UserPayoutRepositoryPort`. The three provisioning methods throw:
 * buying a membership must never provision the OWNER's payout account as a
 * side effect of somebody else pressing a button.
 */
function fakePayoutRepository(seed: UserPayoutAccount[]) {
  const rows = seed.map((row) => ({ ...row }));
  const repository: UserPayoutRepositoryPort = {
    async findPayoutAccount(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async beginXenditAccountProvisioning() {
      throw new Error("StartUserSubscription must never provision a payout account");
    },
    async finishXenditAccountProvisioning() {
      throw new Error("StartUserSubscription must never provision a payout account");
    },
    async abandonXenditAccountProvisioning() {
      throw new Error("StartUserSubscription must never provision a payout account");
    },
  };
  return repository;
}

/**
 * In-memory `UserSubscriptionRepositoryPort` that keeps its rows exposed, so a
 * test can assert what EXISTS after a failure and not only what was returned.
 */
function fakeSubscriptionRepository(seed: UserSubscriptionRow[] = []) {
  const subscriptions = seed.map((row) => ({ ...row }));
  const transactions: UserTransactionRow[] = [];
  const repository: UserSubscriptionRepositoryPort = {
    /** Mirrors `user_subscription_one_pending`: one pending row per (subscriber, owner). */
    async claimPending(input) {
      const held = subscriptions.find(
        (r) =>
          r.subscriberId === input.subscriberId &&
          r.ownerId === input.ownerId &&
          r.status === "pending"
      );
      if (held) return { subscription: { ...held }, created: false };
      return { subscription: await this.create(input), created: true };
    },
    async create(input) {
      const row: UserSubscriptionRow = {
        id: `sub-${subscriptions.length + 1}`,
        subscriberId: input.subscriberId,
        tierId: input.tierId,
        ownerId: input.ownerId,
        status: "pending",
        currentPeriodEnd: null,
        createdAt: new Date("2026-08-20T00:00:00Z"),
      };
      subscriptions.push(row);
      return { ...row };
    },
    async findById(id) {
      const row = subscriptions.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async activate() {
      throw new Error("StartUserSubscription must never activate a subscription — Task 7 does");
    },
    async cancel(id) {
      const row = subscriptions.find((r) => r.id === id);
      if (!row) return null;
      row.status = "cancelled";
      return { ...row };
    },
    async findActiveFor(subscriberId, ownerId) {
      const row = subscriptions.find(
        (r) => r.subscriberId === subscriberId && r.ownerId === ownerId && r.status === "active"
      );
      return row ? { ...row } : null;
    },
    async createTransaction(input) {
      const row: UserTransactionRow = {
        id: `txn-${transactions.length + 1}`,
        userSubscriptionId: input.userSubscriptionId,
        amount: input.amount,
        status: "pending",
        gatewayReferenceId: input.gatewayReferenceId ?? null,
        gatewayInvoiceUrl: null,
        paidAt: null,
        createdAt: new Date("2026-08-20T00:00:00Z"),
      };
      transactions.push(row);
      return { ...row };
    },
    async findTransactionById(id) {
      const row = transactions.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async attachGatewayReference(transactionId, gatewayReferenceId, invoiceUrl) {
      const row = transactions.find((r) => r.id === transactionId);
      if (!row || row.gatewayReferenceId !== null) return false;
      row.gatewayReferenceId = gatewayReferenceId;
      row.gatewayInvoiceUrl = invoiceUrl;
      return true;
    },
    /** Mirrors the Drizzle query's three predicates, including the invoice-url one. */
    async findPendingCheckout(subscriberId, ownerId) {
      const subscription = subscriptions.find(
        (r) => r.subscriberId === subscriberId && r.ownerId === ownerId && r.status === "pending"
      );
      if (!subscription) return null;
      const transaction = transactions
        .filter(
          (t) =>
            t.userSubscriptionId === subscription.id &&
            t.status === "pending" &&
            t.gatewayInvoiceUrl !== null
        )
        .at(-1);
      if (!transaction) return null;
      return {
        subscriptionId: subscription.id,
        tierId: subscription.tierId,
        transactionId: transaction.id,
        invoiceUrl: transaction.gatewayInvoiceUrl!,
      };
    },
    async markTransactionPaid() {
      throw new Error("StartUserSubscription must never settle a transaction — Task 7 does");
    },
  };
  return { repository, subscriptions, transactions };
}

/**
 * Makes ONE named repository method reject exactly once, the way a dropped
 * connection does — the failure the final review's I2 measured. The second
 * call runs the real method, so a test can assert that the retry SUCCEEDS and
 * not merely that the first attempt failed.
 */
function failOnce(
  repository: UserSubscriptionRepositoryPort,
  method: "createTransaction" | "attachGatewayReference"
): void {
  const original = repository[method].bind(repository) as (...args: never[]) => unknown;
  let fired = false;
  (repository as unknown as Record<string, unknown>)[method] = async (...args: never[]) => {
    if (!fired) {
      fired = true;
      throw new Error(`simulated connection reset during ${method}`);
    }
    return original(...args);
  };
}

/** The whole use case, wired to fakes, with every seed overridable per test. */
function build(
  options: {
    users?: UserRecord[];
    tiers?: UserTierRow[];
    payouts?: UserPayoutAccount[];
    subscriptions?: UserSubscriptionRow[];
    /** Simulates one dropped statement inside the claim → attach range (I2). */
    failOnce?: "createTransaction" | "attachGatewayReference";
  } = {}
) {
  const users = options.users ?? [userRecord(), subscriberRecord()];
  const tiers = options.tiers ?? [tierRow()];
  const payouts = options.payouts ?? [payoutAccount()];
  const store = fakeSubscriptionRepository(options.subscriptions ?? []);
  if (options.failOnce) failOnce(store.repository, options.failOnce);
  const payments = new FakePaymentAdapter();
  const clock = new FixedClock(NOW);
  const useCase = new StartUserSubscription(
    fakeUserRepository(users),
    fakeTierRepository(tiers),
    fakePayoutRepository(payouts),
    store.repository,
    payments,
    clock,
    { appBaseUrl: APP_BASE_URL }
  );
  return { useCase, payments, clock, ...store };
}

function buy(useCase: StartUserSubscription, overrides: Partial<Parameters<StartUserSubscription["execute"]>[0]> = {}) {
  return useCase.execute({
    subscriberId: SUBSCRIBER_ID,
    handle: "wildan",
    tierId: "tier-1",
    ...overrides,
  });
}

describe("StartUserSubscription — the happy path", () => {
  it("creates a PENDING subscription and a PENDING transaction, and returns the invoice url", async () => {
    const { useCase, subscriptions, transactions } = build();

    const result = await buy(useCase);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      subscriberId: SUBSCRIBER_ID,
      ownerId: OWNER_ID,
      tierId: "tier-1",
      status: "pending",
      currentPeriodEnd: null,
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      userSubscriptionId: subscriptions[0]!.id,
      amount: 50_000,
      status: "pending",
      paidAt: null,
    });
    expect(result.invoiceUrl).toBe("https://fake-checkout.local/fake-inv-1");
    expect(result.subscriptionId).toBe(subscriptions[0]!.id);
    expect(result.transactionId).toBe(transactions[0]!.id);
  });

  it("opens the invoice against THE OWNER's sub-account, for the tier's own price", async () => {
    const { useCase, payments } = build();

    await buy(useCase);

    expect(payments.invoices).toHaveLength(1);
    expect(payments.invoices[0]!.forAccountId).toBe(OWNER_ACCOUNT);
    expect(payments.invoices[0]!.amount).toBe(50_000);
  });

  it("mints an external_id of `usub_<transactionId>` — the shape Task 7 routes on", async () => {
    const { useCase, payments, transactions } = build();

    const result = await buy(useCase);

    expect(payments.invoices[0]!.externalId).toBe(`${PREFIX}${transactions[0]!.id}`);
    expect(result.externalId).toBe(`${PREFIX}${transactions[0]!.id}`);
    // NOT the bare uuid the community handler resolves — the two invoice kinds
    // share one webhook stream and must never be confusable.
    expect(payments.invoices[0]!.externalId).not.toBe(transactions[0]!.id);
  });

  it("records the provider's invoice id against the transaction, so the webhook has an anchor", async () => {
    const { useCase, transactions } = build();

    await buy(useCase);

    expect(transactions[0]!.gatewayReferenceId).toBe("fake-inv-1");
  });

  it("sends the SUBSCRIBER as the payer and returns them to the owner's profile afterwards", async () => {
    const { useCase, payments } = build();

    await buy(useCase);

    expect(payments.invoices[0]!.payerName).toBe("Rina");
    expect(payments.invoices[0]!.payerWhatsappNumber).toBe("628999888777");
    expect(payments.invoices[0]!.successRedirectUrl).toBe("https://diudara.test/@wildan");
  });

  it("OMITS the payer's number entirely — never an empty string — when they have none on file", async () => {
    const { useCase, payments } = build({
      users: [userRecord(), subscriberRecord({ whatsappNumber: null })],
    });

    await buy(useCase);

    // Absent, not `""`: an empty string is a value the provider still has to
    // format-validate, and it is a shape nothing else in this repository sends.
    expect("payerWhatsappNumber" in payments.invoices[0]!).toBe(false);
    expect(payments.invoices[0]!.payerName).toBe("Rina");
  });

  it("resolves a handle typed with a leading @, exactly as the profile route does", async () => {
    const { useCase, subscriptions } = build();

    await buy(useCase, { handle: "@wildan" });

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.ownerId).toBe(OWNER_ID);
  });
});

describe("StartUserSubscription — the refusals", () => {
  it("404s an unknown handle, in English like every NotFoundError in this codebase", async () => {
    const { useCase, payments, subscriptions } = build();

    await expect(buy(useCase, { handle: "tidakada" })).rejects.toThrow(
      new NotFoundError("user not found")
    );
    expect(subscriptions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("REFUSES subscribing to yourself, in Bahasa, naming what to do instead", async () => {
    const { useCase, payments, subscriptions } = build();

    await expect(buy(useCase, { subscriberId: OWNER_ID })).rejects.toThrow(
      new ConflictError(
        "Anda tidak dapat berlangganan ke diri sendiri. Bagikan tautan profil Anda " +
          "agar orang lain dapat menjadi anggota."
      )
    );
    expect(subscriptions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("REFUSES a DEACTIVATED tier, in Bahasa, naming the remedy", async () => {
    const { useCase, payments, subscriptions } = build({
      tiers: [tierRow({ isActive: false })],
    });

    await expect(buy(useCase)).rejects.toThrow(
      new ConflictError(
        "Tingkatan keanggotaan ini sudah tidak ditawarkan lagi. Pilih tingkatan lain " +
          "yang masih tersedia di profil kreator ini."
      )
    );
    expect(subscriptions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("404s a tier that belongs to somebody else — an owner's price cannot be charged for another's tier", async () => {
    const { useCase, payments, subscriptions } = build({
      tiers: [tierRow({ id: "tier-1", ownerId: "somebody-else" })],
    });

    await expect(buy(useCase)).rejects.toThrow(new NotFoundError("tier not found"));
    expect(subscriptions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("REFUSES an owner with NO payout account at all, in Bahasa, naming the remedy", async () => {
    const { useCase, payments, subscriptions } = build({
      payouts: [payoutAccount({ xenditAccountId: null })],
    });

    await expect(buy(useCase)).rejects.toThrow(
      new ConflictError(
        "Kreator ini belum siap menerima pembayaran. Minta mereka menghubungkan akun " +
          "pembayaran di Pengaturan terlebih dahulu."
      )
    );
    expect(subscriptions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("THE SENTINEL IS NOT AN ACCOUNT: a mid-provisioning owner's tier cannot be bought", async () => {
    // The column is TRUTHY here. `if (owner.xenditAccountId)` would pass, and
    // `for_account_id: "provisioning:in-progress"` — a literal English phrase
    // where a 24-character Xendit object id belongs — would go out on a live
    // payment request against an account that does not exist at the provider.
    const { useCase, payments, subscriptions, transactions } = build({
      payouts: [payoutAccount({ xenditAccountId: SENTINEL })],
    });

    await expect(buy(useCase)).rejects.toThrow(
      new ConflictError(
        "Kreator ini belum siap menerima pembayaran. Minta mereka menghubungkan akun " +
          "pembayaran di Pengaturan terlebih dahulu."
      )
    );
    // Nothing was created, and — the point of this test — the provider was
    // never called with anything at all, let alone with the sentinel.
    expect(subscriptions).toEqual([]);
    expect(transactions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("REFUSES a second membership to the same owner CLEANLY, without creating a second pending row", async () => {
    // The partial unique index (`user_subscription_one_active`) is the backstop
    // and would reject this at the database level — but a constraint violation
    // surfaces as a 500, which is not a refusal anybody can act on. This is the
    // clean refusal; the index stays the backstop.
    const { useCase, payments, subscriptions, transactions } = build({
      subscriptions: [
        {
          id: "sub-existing",
          subscriberId: SUBSCRIBER_ID,
          tierId: "tier-1",
          ownerId: OWNER_ID,
          status: "active",
          currentPeriodEnd: new Date("2099-01-01T00:00:00Z"),
          createdAt: new Date("2026-08-20T00:00:00Z"),
        },
      ],
    });

    await expect(buy(useCase)).rejects.toThrow(
      new ConflictError(
        "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah " +
          "masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."
      )
    );
    expect(subscriptions).toHaveLength(1);
    expect(transactions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("a CANCELLED past membership does not block buying again — only an ACTIVE one does", async () => {
    const { useCase, subscriptions } = build({
      subscriptions: [
        {
          id: "sub-old",
          subscriberId: SUBSCRIBER_ID,
          tierId: "tier-1",
          ownerId: OWNER_ID,
          status: "cancelled",
          currentPeriodEnd: new Date("2026-01-01T00:00:00Z"),
          createdAt: new Date("2025-12-01T00:00:00Z"),
        },
      ],
    });

    await buy(useCase);

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.status).toBe("pending");
  });

  it("an active membership to a DIFFERENT owner does not block this purchase", async () => {
    const { useCase, subscriptions } = build({
      subscriptions: [
        {
          id: "sub-other-owner",
          subscriberId: SUBSCRIBER_ID,
          tierId: "tier-other",
          ownerId: "another-owner",
          status: "active",
          currentPeriodEnd: new Date("2099-01-01T00:00:00Z"),
          createdAt: new Date("2026-08-20T00:00:00Z"),
        },
      ],
    });

    await buy(useCase);

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.ownerId).toBe(OWNER_ID);
  });
});

describe("StartUserSubscription — a second tap must not mint a second invoice", () => {
  it("hands back the invoice already waiting, and creates NO second subscription or transaction", async () => {
    // Two taps on "Jadi anggota" used to open two live invoices. Pay both and
    // the second activation hits `user_subscription_one_active` as a 500 with
    // provider retries behind it — the buyer is simply charged twice, and 5a
    // has no refund path anywhere.
    const { useCase, payments, subscriptions, transactions } = build();

    const first = await buy(useCase);
    const second = await buy(useCase);

    expect(second).toEqual(first);
    expect(subscriptions).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(payments.invoices).toHaveLength(1);
  });

  it("REFUSES a DIFFERENT tier while an invoice is pending, in Bahasa, rather than opening a second one", async () => {
    const { useCase, payments, subscriptions, transactions } = build({
      tiers: [tierRow(), tierRow({ id: "tier-2", name: "Anggota Plus", priceAmount: 100_000 })],
    });
    await buy(useCase);

    await expect(buy(useCase, { tierId: "tier-2" })).rejects.toThrow(
      new ConflictError(
        "Pembayaran keanggotaan untuk kreator ini sedang diproses. Selesaikan dulu " +
          "pembayaran yang sudah dibuka, atau tunggu tagihannya kedaluwarsa sebelum " +
          "memilih tingkatan lain."
      )
    );
    expect(subscriptions).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(payments.invoices).toHaveLength(1);
  });

  it("a pending row whose provider call FAILED does not block a fresh attempt", async () => {
    // The failed attempt left a pending subscription and transaction with NO
    // invoice url. Nothing was charged and nothing is waiting to be paid, so
    // treating it as "a payment is in progress" would lock the buyer out of a
    // purchase for good — 5a has no way to clear a pending row.
    const { useCase, payments, subscriptions, transactions } = build();
    payments.failNextInvoice = true;
    await expect(buy(useCase)).rejects.toThrow("createInvoice failed");

    const result = await buy(useCase);

    expect(result.invoiceUrl).toBe("https://fake-checkout.local/fake-inv-1");
    expect(payments.invoices).toHaveLength(1);
    expect(transactions).toHaveLength(2);
    // A fresh claim, because the failed attempt gave its own back.
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map((r) => r.status)).toEqual(["cancelled", "pending"]);
  });

  it("REFUSES transiently, in Bahasa, while the winner of a double tap is still opening its invoice", async () => {
    // The claim is held but no invoice exists yet — the winner is between its
    // INSERT and its provider call. Milliseconds wide in production, and it must
    // read as "wait a moment", never as a second invoice.
    const { useCase, payments, subscriptions, transactions } = build({
      subscriptions: [
        {
          id: "sub-inflight",
          subscriberId: SUBSCRIBER_ID,
          tierId: "tier-1",
          ownerId: OWNER_ID,
          status: "pending",
          currentPeriodEnd: null,
          createdAt: new Date("2026-08-20T00:00:00Z"),
        },
      ],
    });

    await expect(buy(useCase)).rejects.toThrow(
      new ConflictError(
        "Pembayaran Anda sedang disiapkan. Tunggu sebentar, lalu coba lagi — jangan " +
          "menekan tombol berkali-kali agar Anda tidak ditagih dua kali."
      )
    );
    expect(subscriptions).toHaveLength(1);
    expect(transactions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });
});

describe("StartUserSubscription — the row exists before the provider is called", () => {
  it("leaves a PENDING subscription and transaction behind when the provider call fails", async () => {
    // THE ORDERING, PINNED. The reverse order leaves a live invoice at Xendit
    // whose `external_id` refers to no row at all: the webhook that eventually
    // arrives for it has nothing to resolve, and a member who paid cannot be
    // activated by anything. This way the same failure is inspectable and
    // recoverable — nothing was charged, and the rows say what was attempted.
    const { useCase, payments, subscriptions, transactions } = build();
    payments.failNextInvoice = true;

    await expect(buy(useCase)).rejects.toThrow("fake payment provider: createInvoice failed");

    expect(subscriptions).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.status).toBe("pending");
    // The subscription row is still there and still inspectable — that is what
    // the ordering buys. Its CLAIM, though, has been released: a pending row
    // holds this pair's only pending slot and nothing in 5a ever clears one, so
    // leaving it would wedge this buyer out of this creator for good.
    expect(subscriptions[0]!.status).toBe("cancelled");
    // No invoice was opened, so the transaction carries no gateway reference —
    // exactly the state Task 7 must treat as unverifiable rather than as paid.
    expect(transactions[0]!.gatewayReferenceId).toBeNull();
    expect(payments.invoices).toEqual([]);
  });
});

/**
 * **THE STATE §9 GUARANTEES EVERY PAYING MEMBER REACHES**, and the sentence it
 * used to be answered with was false.
 *
 * 5a has no renewal pass: nothing moves a subscription out of `active` when its
 * period ends, and there is no endpoint to renew one. So one billing cycle
 * after every purchase the row sits at `status = 'active'` with a past
 * `current_period_end`, `IsMemberOf` answers `false` (period-aware) and the
 * guard here still refuses (status-only, and it must — see the guard's own
 * comment). The refusal used to say "Anda sudah menjadi anggota aktif", which
 * is not true of somebody whose membership ended, and the web then advised a
 * reload that re-rendered the same button.
 *
 * The two cases stay two sentences. Both are literals here, and the last
 * assertion is what fails if they are ever collapsed back into one.
 */
describe("StartUserSubscription — a LAPSED membership is refused with the truth", () => {
  const LIVE = "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah " +
    "masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut.";
  const ENDED = "Keanggotaan Anda untuk kreator ini sudah berakhir, dan perpanjangan belum " +
    "tersedia — jadi keanggotaan baru pun belum bisa dibeli. Hubungi kreator " +
    "tersebut jika Anda masih memerlukan akses.";

  /** An `active` row whose period ran out yesterday — §9's own end state. */
  function lapsedRow(): UserSubscriptionRow {
    return {
      id: "sub-lapsed",
      subscriberId: SUBSCRIBER_ID,
      tierId: "tier-1",
      ownerId: OWNER_ID,
      status: "active",
      currentPeriodEnd: new Date("2026-08-19T12:00:00.000Z"),
      createdAt: new Date("2026-07-19T12:00:00.000Z"),
    };
  }

  it("tells a lapsed member their membership ENDED and that renewal is not available", async () => {
    const { useCase, payments, subscriptions, transactions } = build({
      subscriptions: [lapsedRow()],
    });

    await expect(buy(useCase)).rejects.toThrow(new ConflictError(ENDED));

    // Still refused, and still for free: the guard is untouched, only the
    // sentence changed. Nothing was claimed, nothing was charged.
    expect(subscriptions).toHaveLength(1);
    expect(transactions).toEqual([]);
    expect(payments.invoices).toEqual([]);
  });

  it("says something DIFFERENT to a member whose period has not run out", async () => {
    const { useCase } = build({
      subscriptions: [{ ...lapsedRow(), currentPeriodEnd: new Date("2026-09-19T12:00:00.000Z") }],
    });

    await expect(buy(useCase)).rejects.toThrow(new ConflictError(LIVE));
  });

  /**
   * THE PIN. If the two branches are ever collapsed back into one message —
   * the exact defect the final review measured — one of these two literals
   * stops matching, and this reddens whichever way round the collapse went.
   */
  it("the lapsed sentence and the already-active sentence are not the same sentence", async () => {
    const lapsed = build({ subscriptions: [lapsedRow()] });
    const live = build({
      subscriptions: [{ ...lapsedRow(), currentPeriodEnd: new Date("2026-09-19T12:00:00.000Z") }],
    });

    const forLapsed = await buy(lapsed.useCase).catch((err: unknown) => (err as Error).message);
    const forLive = await buy(live.useCase).catch((err: unknown) => (err as Error).message);

    expect(forLapsed).toBe(ENDED);
    expect(forLive).toBe(LIVE);
    expect(forLapsed).not.toBe(forLive);
    // And neither of them invites a retry that cannot work.
    expect(forLapsed).not.toContain("coba lagi");
    expect(forLapsed).not.toContain("Muat ulang");
  });

  it("the BOUNDARY: a period ending exactly now has ended — `>` , not `>=`", async () => {
    // `IsMemberOf` uses strict `>`, so an instant equal to `now` is NOT a
    // member. This refusal reads the same comparison through
    // `membershipStanding`, so the two cannot drift apart.
    const { useCase } = build({ subscriptions: [{ ...lapsedRow(), currentPeriodEnd: NOW }] });

    await expect(buy(useCase)).rejects.toThrow(new ConflictError(ENDED));
  });

  it("an `active` row with NO period end is treated as ended, never as a live membership", async () => {
    // Unreachable through `activate`, which always writes a period end. If it
    // ever happened the row would grant nothing while still blocking the
    // purchase, which is what "ended" means — and claiming "you are an active
    // member" would be the one answer that is definitely false.
    const { useCase } = build({ subscriptions: [{ ...lapsedRow(), currentPeriodEnd: null }] });

    await expect(buy(useCase)).rejects.toThrow(new ConflictError(ENDED));
  });
});

/**
 * **I2 — ONE FAILED STATEMENT MUST NOT WEDGE A BUYER OUT PERMANENTLY.**
 *
 * The pending claim is this pair's only pending slot and nothing in 5a clears
 * one. Round 2 released it around `payments.createInvoice` alone; the final
 * whole-branch review measured what the other two statements in that range do.
 * On the real route, one simulated connection reset on `attachGatewayReference`
 * gave attempt 1 a 500 with an invoice already open at the provider, attempts 2
 * and 3 the transient 409 — "Tunggu sebentar, lalu coba lagi" — and
 * `findPendingCheckout → null` forever. The message says temporary; the state
 * was permanent.
 *
 * So: a failure at EACH statement between the claim and the reference, and each
 * one must give the claim back and let the very next attempt succeed. The
 * transient 409 is the tell — if it appears on the retry, the claim was not
 * released.
 */
describe("StartUserSubscription — every statement between the claim and the invoice reference releases it", () => {
  const TRANSIENT =
    "Pembayaran Anda sedang disiapkan. Tunggu sebentar, lalu coba lagi — jangan " +
    "menekan tombol berkali-kali agar Anda tidak ditagih dua kali.";

  it("createTransaction: the claim is released, and the retry succeeds", async () => {
    const { useCase, payments, subscriptions, transactions } = build({
      failOnce: "createTransaction",
    });

    await expect(buy(useCase)).rejects.toThrow("simulated connection reset during createTransaction");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.status).toBe("cancelled");
    // Nothing reached the provider, so nothing is owed by anybody.
    expect(payments.invoices).toEqual([]);

    const retry = await buy(useCase);

    expect(retry.invoiceUrl).toBe("https://fake-checkout.local/fake-inv-1");
    expect(subscriptions.map((r) => r.status)).toEqual(["cancelled", "pending"]);
    expect(transactions).toHaveLength(1);
  });

  it("createInvoice: the claim is released, and the retry succeeds", async () => {
    // Round 2 already covered this one. It is here so the three statements are
    // pinned as a RANGE rather than as one covered case beside two gaps.
    const { useCase, payments, subscriptions, transactions } = build();
    payments.failNextInvoice = true;

    await expect(buy(useCase)).rejects.toThrow("createInvoice failed");
    expect(subscriptions[0]!.status).toBe("cancelled");

    const retry = await buy(useCase);

    expect(retry.invoiceUrl).toBe("https://fake-checkout.local/fake-inv-1");
    expect(subscriptions.map((r) => r.status)).toEqual(["cancelled", "pending"]);
    expect(payments.invoices).toHaveLength(1);
    expect(transactions).toHaveLength(2);
  });

  it("attachGatewayReference: the claim is released, and the retry succeeds", async () => {
    // THE ONE THE REVIEW MEASURED. An invoice is already open at the provider
    // when this fails, and the buyer would previously have been told to wait
    // and try again — forever, because `findPendingCheckout` requires an
    // invoice url the failed attempt never recorded.
    const { useCase, payments, subscriptions, transactions } = build({
      failOnce: "attachGatewayReference",
    });

    await expect(buy(useCase)).rejects.toThrow(
      "simulated connection reset during attachGatewayReference"
    );
    expect(payments.invoices).toHaveLength(1);
    expect(subscriptions[0]!.status).toBe("cancelled");
    // The transaction row stays, with no gateway reference — the inspectable
    // record the row-before-provider ordering exists to leave behind, and the
    // state Task 7 must refuse to verify rather than settle.
    expect(transactions[0]!.gatewayReferenceId).toBeNull();

    const retry = await buy(useCase);

    expect(retry.invoiceUrl).toBe("https://fake-checkout.local/fake-inv-2");
    expect(subscriptions.map((r) => r.status)).toEqual(["cancelled", "pending"]);
    expect(transactions).toHaveLength(2);
    expect(transactions[1]!.gatewayReferenceId).not.toBeNull();
  });

  it("NONE of the three leaves the buyer stuck on the transient refusal", async () => {
    // The measured symptom, asserted directly: attempts 2 and 3 used to be the
    // "wait a moment" 409 for a state that never resolved.
    for (const failure of ["createTransaction", "attachGatewayReference"] as const) {
      const { useCase } = build({ failOnce: failure });
      await expect(buy(useCase)).rejects.toThrow("simulated connection reset");

      const second = await buy(useCase).catch((err: unknown) => (err as Error).message);

      expect(second).not.toBe(TRANSIENT);
    }
  });

  it("a release that itself fails does not replace the original error, and warns", async () => {
    // `releaseClaim` is called from a catch. If it threw, the buyer would be
    // wedged AND the reason for it would be lost — the one thing worse than
    // the wedge.
    const { useCase, repository } = build({ failOnce: "createTransaction" });
    repository.cancel = async () => {
      throw new Error("cancel also lost its connection");
    };
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));

    try {
      await expect(buy(useCase)).rejects.toThrow(
        "simulated connection reset during createTransaction"
      );
    } finally {
      console.warn = realWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not release the pending claim");
  });
});
