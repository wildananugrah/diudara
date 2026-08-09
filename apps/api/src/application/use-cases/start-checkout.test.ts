import { describe, expect, it } from "bun:test";
import { FakePaymentAdapter } from "../../infrastructure/payments/fake-payment.adapter";
import { StartCheckout } from "./start-checkout";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";

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
      async findTransactionByExternalId() {
        return null;
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
      payments
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
  });
});
