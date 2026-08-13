import { describe, expect, it } from "bun:test";
import { FixedClock } from "../../infrastructure/clock/fixed.clock";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
import { ConflictError } from "../errors";
import { StartCheckout } from "./start-checkout";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";

const APP_BASE_URL = "https://app.diudara.test";

/** The id the harness's existing subscription has, when the member holds one. */
const EXISTING_SUBSCRIPTION_ID = "existing-subscription-1";

/** 09:00 WIB on 2026-03-07, i.e. three WIB days before a 2026-03-10 due date. */
const THREE_DAYS_BEFORE_DUE = new Date("2026-03-07T02:00:00.000Z");

/**
 * An `active` subscription nowhere near its renewal: due on 2026-03-10, and every test
 * that uses this runs with the clock at 2026-02-10. This is the case Phase 3's 409
 * exists for, and it must keep 409ing.
 */
const FAR_FROM_RENEWAL = { status: "active", nextBillingDate: "2026-03-10" };

describe("StartCheckout — funds routing", () => {
  it("charges the creator's account, never a platform account", async () => {
    // Assembled with fakes; see the route test for the wired version.
    const payments = new FakePaymentAdapter();
    await payments.createInvoice({
      externalId: "txn-1",
      amount: 50000,
      description: "Basic",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
      forAccountId: "acct-creator-1",
      successRedirectUrl: "http://localhost:5173/c/kelas-budi/status/sub-1",
    });

    expect(payments.invoices[0].forAccountId).toBe("acct-creator-1");
    expect(payments.invoices.every((i) => i.forAccountId.length > 0)).toBe(true);
  });

  /**
   * Wires StartCheckout itself (not just the adapter in isolation) with
   * hand-written fake ports, and asserts the value the fake adapter actually
   * RECORDED — not by reading start-checkout.ts and trusting it passes
   * creator.xenditAccountId through. "acct-creator-xyz" is a value that
   * appears nowhere in start-checkout.ts, so this can only pass if the
   * use-case genuinely reads it off the CreatorRepositoryPort result.
   */
  it("wires the creator's own xenditAccountId into the invoice, not any hardcoded value", async () => {
    const CREATOR_ACCOUNT_ID = "acct-creator-xyz";
    const attached: { transactionId: string; gatewayReferenceId: string }[] = [];

    const communities: CommunityRepositoryPort = {
      async create() {
        throw new Error("not used");
      },
      async findByIdForCreator() {
        return null;
      },
      async listByCreator() {
        return [];
      },
      async slugExists() {
        return false;
      },
      async update() {
        return null;
      },
      async findBySlug(slug) {
        return {
          id: "community-1",
          creatorId: "creator-1",
          name: "Kelas Budi",
          slug,
          niche: null,
          status: "active",
          accessMode: "paid",
          createdAt: new Date(0),
        };
      },
    };

    const tiers: MembershipTierRepositoryPort = {
      async create() {
        throw new Error("not used");
      },
      async listByCommunity() {
        return [
          {
            id: "tier-1",
            communityId: "community-1",
            name: "Basic",
            priceAmount: 50000,
            billingCycle: "monthly",
            isActive: true,
          },
        ];
      },
      async updateForCommunity() {
        return null;
      },
    };

    const members: MemberRepositoryPort = {
      async findOrCreateByWhatsappNumber(input) {
        return {
          id: "member-1",
          whatsappNumber: input.whatsappNumber,
          name: input.name,
          joinedAt: new Date(0),
        };
      },
      async findById() {
        throw new Error("not used");
      },
    };

    const subscriptions: SubscriptionRepositoryPort = {
      async createPending(input) {
        return {
          id: "subscription-1",
          memberId: input.memberId,
          tierId: input.tierId,
          status: "pending",
          nextBillingDate: null,
          // No grace deadline: only entering `past_due` (Phase 5) writes one.
          graceEndsAt: null,
          startedAt: null,
          retryCount: 0,
          lastAttemptAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      },
      async createActiveWithoutBilling() {
        throw new Error("not used");
      },
      async createTransaction(input) {
        return {
          id: "transaction-1",
          subscriptionId: input.subscriptionId,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          status: "pending",
          gatewayReferenceId: null,
          paidAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      },
      async findById() {
        throw new Error("not used");
      },
      async findByIdWithCommunity() {
        throw new Error("not used");
      },
      async findTransactionByExternalId() {
        return null;
      },
      async findCurrentSubscriptionForTier() {
        return null;
      },
      async attachGatewayReference(transactionId, gatewayReferenceId) {
        attached.push({ transactionId, gatewayReferenceId });
        return true;
      },
      async findDueForRenewal() {
        throw new Error("not used");
      },
      async markPastDue() {
        throw new Error("not used");
      },
      async findPastGraceDeadline() {
        throw new Error("not used");
      },
      async markChurned() {
        throw new Error("not used");
      },
      async findRenewalContext() {
        throw new Error("not used");
      },
      async hasLiveSubscriptionInCommunity() {
        throw new Error("not used");
      },
      async listActiveForCommunity() {
        throw new Error("not used");
      },
      async markPaid() {
        throw new Error("not used");
      },
    };

    const creators: CreatorRepositoryPort = {
      async create() {
        throw new Error("not used");
      },
      async findById(id) {
        return {
          id,
          name: "Budi",
          whatsappNumber: null,
          email: "budi@example.com",
          tierPlan: "starter",
          xenditAccountId: CREATOR_ACCOUNT_ID,
          createdAt: new Date(0),
        };
      },
      async findByEmail() {
        return null;
      },
      async findCredentialsByEmail() {
        return null;
      },
      async beginXenditAccountProvisioning() {
        return false;
      },
      async finishXenditAccountProvisioning() {
        return false;
      },
      async abandonXenditAccountProvisioning() {
        return false;
      },
    };

    const payments = new FakePaymentAdapter();

    const startCheckout = new StartCheckout(
      communities,
      tiers,
      members,
      subscriptions,
      creators,
      payments,
      new FixedClock(new Date("2026-02-10T02:00:00.000Z")),
      { appBaseUrl: APP_BASE_URL }
    );

    const result = await startCheckout.execute({
      slug: "kelas-budi",
      tierId: "tier-1",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
    });

    expect(result.transactionId).toBe("transaction-1");
    expect(result.subscriptionId).toBe("subscription-1");
    expect(payments.invoices).toHaveLength(1);
    expect(payments.invoices[0].forAccountId).toBe(CREATOR_ACCOUNT_ID);

    // I2, final whole-branch review: the provider's invoice id has to be
    // persisted against OUR transaction, or the webhook has nothing to check
    // `body.id` against and the whole replay defence rests on an unverified
    // field. "fake-inv-1" is what FakePaymentAdapter returns.
    expect(attached).toEqual([
      { transactionId: "transaction-1", gatewayReferenceId: "fake-inv-1" },
    ]);

    // I1, final whole-branch review: Task 9's confirmation page was unreachable
    // — nothing linked to /c/:slug/status/:subscriptionId and no
    // success_redirect_url was sent, so a member who paid was left on the
    // provider's receipt. The created invoice must carry a URL containing the
    // SUBSCRIPTION ID, which is the only thing that page can be opened with.
    const redirect = payments.invoices[0].successRedirectUrl;
    expect(redirect).toContain("subscription-1");
    expect(redirect).toBe(`${APP_BASE_URL}/c/kelas-budi/status/subscription-1`);
  });

  it("builds the redirect from the configured base url, not a hardcoded origin", async () => {
    // APP_BASE_URL appears nowhere in start-checkout.ts, so this can only pass if
    // the use-case genuinely reads its config.
    const { startCheckout, payments } = harness({ appBaseUrl: "https://diudara.example" });

    const result = await startCheckout.execute({
      slug: "kelas-budi",
      tierId: "tier-1",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
    });

    expect(payments.invoices[0].successRedirectUrl).toBe(
      `https://diudara.example/c/kelas-budi/status/${result.subscriptionId}`
    );
  });

  it("uses the community's CANONICAL slug in the redirect, not the requested one", async () => {
    // findBySlug is the only unscoped lookup in the codebase; if it ever resolves
    // a row by an alias, the redirect must still point at a URL that loads.
    const { startCheckout, payments } = harness({ canonicalSlug: "kelas-budi" });

    await startCheckout.execute({
      slug: "KELAS-BUDI",
      tierId: "tier-1",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
    });

    expect(payments.invoices[0].successRedirectUrl).toContain("/c/kelas-budi/status/");
    expect(payments.invoices[0].successRedirectUrl).not.toContain("KELAS-BUDI");
  });
});

/**
 * Task 7 item 1, second half. `CreatePaymentAccount` now CLAIMS
 * `creator.xendit_account_id` with a sentinel before it calls Xendit, so the
 * column has a third state: not connected, PROVISIONING, connected. StartCheckout
 * reads that column and used to treat any non-empty value as payable — which
 * would hand the sentinel to `createInvoice` as `for_account_id` and charge a
 * member against an account id that does not exist at the provider.
 *
 * The sentinel is written as a LITERAL here rather than imported: this asserts the
 * behaviour for the value the other half of the feature actually writes, and a
 * shared import would let both sides drift together silently. The
 * `isProvisioningPlaceholder` test in domain/payment-account.test.ts pins that the
 * two agree.
 */
describe("StartCheckout — a half-provisioned payment account is not payable", () => {
  it("409s instead of charging against the provisioning sentinel", async () => {
    const { startCheckout, payments } = harness({
      creatorXenditAccountId: "provisioning:in-progress",
    });

    await expect(
      startCheckout.execute({
        slug: "kelas-budi",
        tierId: "tier-1",
        payerName: "Siti",
        payerWhatsappNumber: "+6281234567890",
      })
    ).rejects.toBeInstanceOf(ConflictError);

    // The assertion that matters: no invoice exists, so no member was ever shown
    // a payment page for an account that cannot receive money.
    expect(payments.invoices).toHaveLength(0);
  });

  it("still charges normally once the real account id has replaced the sentinel", async () => {
    // The guard must be the sentinel specifically, not "looks unusual".
    const { startCheckout, payments } = harness({ creatorXenditAccountId: "acct-real-123" });

    await startCheckout.execute({
      slug: "kelas-budi",
      tierId: "tier-1",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
    });

    expect(payments.invoices[0].forAccountId).toBe("acct-real-123");
  });
});

/**
 * I1, final whole-branch review: checkout took money for a purchase it could never
 * deliver.
 *
 * `createPending` never looked for an existing `active` subscription to the same
 * tier. A member who re-paid — and re-paying is EXACTLY what someone does when the
 * group invite did not arrive — was charged; `markPaid` then returned `superseded`,
 * the subscription was `cancelled`, no `grant_access` outbox row was enqueued so no
 * WhatsApp message was sent at all, and the status page they were redirected to read
 * `cancelled`. Money in, nothing out, member never told.
 */
describe("StartCheckout — a member who already holds the tier is not charged again", () => {
  it("409s BEFORE the invoice is created", async () => {
    const { startCheckout, payments } = harness({ currentSubscription: FAR_FROM_RENEWAL });

    await expect(
      startCheckout.execute({
        slug: "kelas-budi",
        tierId: "tier-1",
        payerName: "Siti",
        payerWhatsappNumber: "+6281234567890",
      })
    ).rejects.toBeInstanceOf(ConflictError);

    // THE ASSERTION: no invoice exists, so nobody was shown a payment page. A 409
    // after `createInvoice` would still have taken the money.
    expect(payments.invoices).toHaveLength(0);
  });

  it("tells the member what to do instead of paying again", async () => {
    // The refusal is read by a person who is trying to fix a missing invite, so it
    // has to say that paying again will not produce one.
    const { startCheckout } = harness({ currentSubscription: FAR_FROM_RENEWAL });

    const error = (await startCheckout
      .execute({
        slug: "kelas-budi",
        tierId: "tier-1",
        payerName: "Siti",
        payerWhatsappNumber: "+6281234567890",
      })
      .catch((e) => e)) as ConflictError;

    expect(error.message).toMatch(/already have an active membership/i);
    expect(error.message).toMatch(/contact the community owner/i);
  });

  it("checks the resolved member and tier, not the request's raw values", async () => {
    // The member id comes from `findOrCreateByWhatsappNumber` and the tier id from
    // the tier row that was actually resolved and found active — checking the
    // request body instead would miss a member who already exists under a
    // normalised number.
    const { startCheckout, activeSubscriptionChecks } = harness();

    await startCheckout.execute({
      slug: "kelas-budi",
      tierId: "tier-1",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
    });

    expect(activeSubscriptionChecks).toEqual([{ memberId: "member-1", tierId: "tier-1" }]);
  });

  it("still charges a member who does NOT hold the tier", async () => {
    const { startCheckout, payments } = harness();

    await startCheckout.execute({
      slug: "kelas-budi",
      tierId: "tier-1",
      payerName: "Siti",
      payerWhatsappNumber: "+6281234567890",
    });

    expect(payments.invoices).toHaveLength(1);
  });
});

/**
 * A minimal StartCheckout wired to fake ports. Only the knobs the redirect tests
 * need are configurable; the exhaustive-fakes version above stays as it is
 * because it asserts the full port contract with no casts.
 */
function harness(
  options: {
    appBaseUrl?: string;
    canonicalSlug?: string;
    creatorXenditAccountId?: string;
    /**
     * The member's CURRENT subscription to this tier — `active` or `past_due` — or
     * nothing. Phase 5 replaced the boolean this used to be: "do they already hold it"
     * cannot express "are they inside their renewal window", which is now what decides
     * between a 409 and a renewal.
     */
    currentSubscription?: { status: string; nextBillingDate: string | null };
    /** What the injected clock reads. Only the renewal-window tests care. */
    now?: Date;
  } = {}
) {
  const activeSubscriptionChecks: { memberId: string; tierId: string }[] = [];
  const createPendingCalls: { memberId: string; tierId: string }[] = [];
  const transactionSubscriptionIds: string[] = [];
  const communities: CommunityRepositoryPort = {
    async create() {
      throw new Error("not used");
    },
    async findByIdForCreator() {
      return null;
    },
    async listByCreator() {
      return [];
    },
    async slugExists() {
      return false;
    },
    async update() {
      return null;
    },
    async findBySlug(slug) {
      return {
        id: "community-1",
        creatorId: "creator-1",
        name: "Kelas Budi",
        slug: options.canonicalSlug ?? slug,
        niche: null,
        status: "active",
        accessMode: "paid",
        createdAt: new Date(0),
      };
    },
  };

  const tiers: MembershipTierRepositoryPort = {
    async create() {
      throw new Error("not used");
    },
    async listByCommunity() {
      return [
        {
          id: "tier-1",
          communityId: "community-1",
          name: "Basic",
          priceAmount: 50000,
          billingCycle: "monthly",
          isActive: true,
        },
      ];
    },
    async updateForCommunity() {
      return null;
    },
  };

  const members: MemberRepositoryPort = {
    async findOrCreateByWhatsappNumber(input) {
      return { id: "member-1", whatsappNumber: input.whatsappNumber, name: input.name, joinedAt: new Date(0) };
    },
    async findById() {
      throw new Error("not used");
    },
  };

  const subscriptions: SubscriptionRepositoryPort = {
    async createPending(input) {
      createPendingCalls.push(input);
      return {
        id: "subscription-1",
        memberId: input.memberId,
        tierId: input.tierId,
        status: "pending",
        nextBillingDate: null,
        graceEndsAt: null,
        startedAt: null,
        retryCount: 0,
        lastAttemptAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async createActiveWithoutBilling() {
      throw new Error("not used");
    },
    async createTransaction(input) {
      transactionSubscriptionIds.push(input.subscriptionId);
      return {
        id: "transaction-1",
        subscriptionId: input.subscriptionId,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        status: "pending",
        gatewayReferenceId: null,
        paidAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async findById() {
      throw new Error("not used");
    },
    async findByIdWithCommunity() {
      throw new Error("not used");
    },
    async findTransactionByExternalId() {
      return null;
    },
    async findCurrentSubscriptionForTier(memberId, tierId) {
      activeSubscriptionChecks.push({ memberId, tierId });
      const current = options.currentSubscription;
      if (current === undefined) return null;
      return {
        id: EXISTING_SUBSCRIPTION_ID,
        memberId,
        tierId,
        status: current.status,
        nextBillingDate: current.nextBillingDate,
        graceEndsAt: current.status === "past_due" ? new Date("2026-03-17T00:00:00.000Z") : null,
        startedAt: new Date("2026-02-10T02:00:00.000Z"),
        retryCount: 0,
        lastAttemptAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async attachGatewayReference() {
      return true;
    },
    async findDueForRenewal() {
      throw new Error("not used");
    },
    async markPastDue() {
      throw new Error("not used");
    },
    async findPastGraceDeadline() {
      throw new Error("not used");
    },
    async markChurned() {
      throw new Error("not used");
    },
    async findRenewalContext() {
      throw new Error("not used");
    },
    async hasLiveSubscriptionInCommunity() {
      throw new Error("not used");
    },
    async listActiveForCommunity() {
      throw new Error("not used");
    },
    async markPaid() {
      throw new Error("not used");
    },
  };

  const creators: CreatorRepositoryPort = {
    async create() {
      throw new Error("not used");
    },
    async findById(id) {
      return {
        id,
        name: "Budi",
        whatsappNumber: null,
        email: "budi@example.com",
        tierPlan: "starter",
        xenditAccountId: options.creatorXenditAccountId ?? "acct-creator-1",
        createdAt: new Date(0),
      };
    },
    async findByEmail() {
      return null;
    },
    async findCredentialsByEmail() {
      return null;
    },
    async beginXenditAccountProvisioning() {
      return false;
    },
    async finishXenditAccountProvisioning() {
      return false;
    },
    async abandonXenditAccountProvisioning() {
      return false;
    },
  };

  const payments = new FakePaymentAdapter();
  const clock = new FixedClock(options.now ?? new Date("2026-02-10T02:00:00.000Z"));
  const startCheckout = new StartCheckout(
    communities,
    tiers,
    members,
    subscriptions,
    creators,
    payments,
    clock,
    { appBaseUrl: options.appBaseUrl ?? APP_BASE_URL }
  );
  return {
    startCheckout,
    payments,
    clock,
    activeSubscriptionChecks,
    createPendingCalls,
    transactionSubscriptionIds,
  };
}

/**
 * Phase 5, Task 6(a): THE `pre_3d` REMINDER'S LINK USED TO 409.
 *
 * The reminder whose entire purpose is "renew without ever losing access" pointed at a
 * checkout that refused the member, because they were still `active` and Phase 3's rule
 * looked at nothing else. Task 4 found it; the brief only mentioned `past_due`, so the
 * brief was wrong.
 *
 * THE PREDICATE CHOSEN, and it is deliberately not "any active member may pay again":
 *
 *   a member with an existing `active` or `past_due` subscription to this tier may check
 *   out exactly when `status === "past_due"`, OR when the subscription is `active` and
 *   `isInsideRenewalWindow(next_billing_date, now)` — i.e. from the first reminder stage
 *   (three days before the due date) onwards. Anything else is still a 409.
 *
 * It is the SAME window that makes a reminder go out, read from the same domain module,
 * so the rule is "if we asked you to renew, the link works" rather than a second
 * threshold that could drift from the schedule. A member with no `next_billing_date` at
 * all, and a member with weeks to go, are not renewing — they are double-buying, which
 * is what the 409 is for.
 */
describe("StartCheckout — the renewal window", () => {
  const RENEW = {
    slug: "kelas-budi",
    tierId: "tier-1",
    payerName: "Siti",
    payerWhatsappNumber: "+6281234567890",
  };

  it("lets a PAST_DUE member renew rather than 409ing", async () => {
    const { startCheckout, payments } = harness({
      currentSubscription: { status: "past_due", nextBillingDate: "2026-03-10" },
      now: new Date("2026-03-15T02:00:00.000Z"),
    });

    const result = await startCheckout.execute(RENEW);

    expect(payments.invoices).toHaveLength(1);
    expect(result.subscriptionId).toBe(EXISTING_SUBSCRIPTION_ID);
  });

  it("lets an ACTIVE member inside the pre_3d window renew — the reminder link must work", async () => {
    const { startCheckout, payments } = harness({
      currentSubscription: { status: "active", nextBillingDate: "2026-03-10" },
      now: THREE_DAYS_BEFORE_DUE,
    });

    const result = await startCheckout.execute(RENEW);

    expect(payments.invoices).toHaveLength(1);
    expect(result.subscriptionId).toBe(EXISTING_SUBSCRIPTION_ID);
  });

  it("still 409s an ACTIVE member who is nowhere near renewal", async () => {
    const { startCheckout, payments } = harness({
      currentSubscription: FAR_FROM_RENEWAL,
      // A month out. Phase 3's rule, unchanged: paying now buys nothing.
      now: new Date("2026-02-10T02:00:00.000Z"),
    });

    await expect(startCheckout.execute(RENEW)).rejects.toBeInstanceOf(ConflictError);
    expect(payments.invoices).toHaveLength(0);
  });

  it("409s an ACTIVE member the day BEFORE the window opens", async () => {
    // The boundary, in Asia/Jakarta: four WIB days out is outside, three is inside.
    // Asserted so the window cannot quietly widen by a day.
    const { startCheckout } = harness({
      currentSubscription: FAR_FROM_RENEWAL,
      now: new Date("2026-03-06T02:00:00.000Z"),
    });

    await expect(startCheckout.execute(RENEW)).rejects.toBeInstanceOf(ConflictError);
  });

  it("409s an ACTIVE member with no next_billing_date at all", async () => {
    // Nothing writes this today — activation always sets one — but the column is
    // nullable, and "no due date" must not be read as "due now".
    const { startCheckout } = harness({
      currentSubscription: { status: "active", nextBillingDate: null },
      now: THREE_DAYS_BEFORE_DUE,
    });

    await expect(startCheckout.execute(RENEW)).rejects.toBeInstanceOf(ConflictError);
  });

  it("REUSES the subscription row rather than creating a second one", async () => {
    // The row is the thing being renewed. A new `pending` row would activate alongside
    // the old one, which stays `past_due` — so the churn pass would revoke the access
    // the member has just paid for, and `subscription_member_tier_active_unique` would
    // be the only thing standing between them and two active subscriptions.
    const { startCheckout, createPendingCalls, transactionSubscriptionIds } = harness({
      currentSubscription: { status: "past_due", nextBillingDate: "2026-03-10" },
      now: new Date("2026-03-15T02:00:00.000Z"),
    });

    await startCheckout.execute(RENEW);

    expect(createPendingCalls).toEqual([]);
    expect(transactionSubscriptionIds).toEqual([EXISTING_SUBSCRIPTION_ID]);
  });

  it("still creates a new subscription for a member who holds nothing", async () => {
    const { startCheckout, createPendingCalls, transactionSubscriptionIds } = harness();

    await startCheckout.execute(RENEW);

    expect(createPendingCalls).toEqual([{ memberId: "member-1", tierId: "tier-1" }]);
    expect(transactionSubscriptionIds).toEqual(["subscription-1"]);
  });
});
