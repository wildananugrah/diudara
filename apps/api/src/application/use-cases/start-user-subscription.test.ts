import { describe, expect, it } from "bun:test";
import { StartUserSubscription } from "./start-user-subscription";
import { ConflictError, NotFoundError } from "../errors";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
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

/** The whole use case, wired to fakes, with every seed overridable per test. */
function build(
  options: {
    users?: UserRecord[];
    tiers?: UserTierRow[];
    payouts?: UserPayoutAccount[];
    subscriptions?: UserSubscriptionRow[];
  } = {}
) {
  const users = options.users ?? [userRecord(), subscriberRecord()];
  const tiers = options.tiers ?? [tierRow()];
  const payouts = options.payouts ?? [payoutAccount()];
  const store = fakeSubscriptionRepository(options.subscriptions ?? []);
  const payments = new FakePaymentAdapter();
  const useCase = new StartUserSubscription(
    fakeUserRepository(users),
    fakeTierRepository(tiers),
    fakePayoutRepository(payouts),
    store.repository,
    payments,
    { appBaseUrl: APP_BASE_URL }
  );
  return { useCase, payments, ...store };
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
