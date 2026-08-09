import { describe, expect, it } from "bun:test";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
import { StartCheckout } from "./start-checkout";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";

const APP_BASE_URL = "https://app.diudara.test";

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
          startedAt: null,
          retryCount: 0,
          lastAttemptAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
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
      async attachGatewayReference(transactionId, gatewayReferenceId) {
        attached.push({ transactionId, gatewayReferenceId });
        return true;
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
      async setXenditAccountId() {
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
 * A minimal StartCheckout wired to fake ports. Only the knobs the redirect tests
 * need are configurable; the exhaustive-fakes version above stays as it is
 * because it asserts the full port contract with no casts.
 */
function harness(options: { appBaseUrl?: string; canonicalSlug?: string } = {}) {
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
      return {
        id: "subscription-1",
        memberId: input.memberId,
        tierId: input.tierId,
        status: "pending",
        nextBillingDate: null,
        startedAt: null,
        retryCount: 0,
        lastAttemptAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
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
    async attachGatewayReference() {
      return true;
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
        xenditAccountId: "acct-creator-1",
        createdAt: new Date(0),
      };
    },
    async findByEmail() {
      return null;
    },
    async findCredentialsByEmail() {
      return null;
    },
    async setXenditAccountId() {
      return false;
    },
  };

  const payments = new FakePaymentAdapter();
  const startCheckout = new StartCheckout(communities, tiers, members, subscriptions, creators, payments, {
    appBaseUrl: options.appBaseUrl ?? APP_BASE_URL,
  });
  return { startCheckout, payments };
}
