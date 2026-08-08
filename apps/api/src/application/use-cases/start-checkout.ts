import { ConflictError, NotFoundError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type { SubscriptionRepositoryPort } from "../ports/subscription-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import { VISIBLE_STATUSES } from "./get-public-community";

export class StartCheckout {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly creators: CreatorRepositoryPort,
    private readonly payments: PaymentProviderPort
  ) {}

  async execute(input: {
    slug: string;
    tierId: string;
    payerName: string;
    payerWhatsappNumber: string;
  }): Promise<{ invoiceUrl: string; subscriptionId: string; transactionId: string }> {
    // Re-checked here, server-side, against the SAME allowlist GetPublicCommunity
    // uses for rendering — never trust a client-supplied acceptingNewMembers,
    // which arrives from the browser and isn't even sent on this request.
    const community = await this.communities.findBySlug(input.slug);
    if (!community || !VISIBLE_STATUSES.has(community.status)) {
      throw new NotFoundError("community not found");
    }
    // Spec §9.1: paused communities still RENDER (shared WhatsApp links keep
    // working) but cannot be purchased. Visible-but-not-active is exactly
    // "paused" today; any future status added to the allowlist that isn't
    // "active" gets the same treatment rather than silently falling through.
    if (community.status !== "active") {
      throw new ConflictError("this community is not accepting new members right now");
    }

    const tiers = await this.tiers.listByCommunity(community.id);
    const tier = tiers.find((t) => t.id === input.tierId && t.isActive);
    if (!tier) {
      throw new NotFoundError("tier not found");
    }

    const creator = await this.creators.findById(community.creatorId);
    // No account means no sub-account to settle into. Charging anyway would put
    // member funds in a platform account — the PJP hazard. Refuse.
    if (!creator?.xenditAccountId) {
      throw new ConflictError("this community is not ready to accept payments yet");
    }

    const member = await this.members.findOrCreateByWhatsappNumber({
      whatsappNumber: input.payerWhatsappNumber,
      name: input.payerName,
    });

    const subscription = await this.subscriptions.createPending({
      memberId: member.id,
      tierId: tier.id,
    });
    const transaction = await this.subscriptions.createTransaction({
      subscriptionId: subscription.id,
      amount: tier.priceAmount,
      paymentMethod: "invoice",
    });

    const invoice = await this.payments.createInvoice({
      externalId: transaction.id,
      amount: tier.priceAmount,
      description: `${community.name} — ${tier.name}`,
      payerName: input.payerName,
      payerWhatsappNumber: input.payerWhatsappNumber,
      forAccountId: creator.xenditAccountId,
    });

    return {
      invoiceUrl: invoice.invoiceUrl,
      subscriptionId: subscription.id,
      transactionId: transaction.id,
    };
  }
}
