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

    // The idempotency ANCHOR. Without this write the webhook has nothing of ours
    // to check `body.id` against, so it accepts whatever the body claims — and
    // since `provider_event_id` derives from that same `body.id`, the entire
    // replay defence would rest on a field we never verify. Probed before it
    // existed: 12 concurrent PAID deliveries with 12 different `body.id`s
    // produced 12 `activity_log` "joined" rows, all 200.
    //
    // Deliberately AFTER createInvoice and as a second write, rather than
    // folding the reference into `createTransaction` by pre-generating the id and
    // calling the provider first. Reversing the order would mean a failure
    // between the two leaves a live invoice at the provider whose `external_id`
    // matches no transaction row at all — a member could pay it and the webhook
    // would 404 forever, with nothing to reconstruct the row from. This way the
    // same failure leaves a transaction we can still find from the webhook and
    // repair with the invoice id the provider's dashboard shows.
    if (!(await this.subscriptions.attachGatewayReference(transaction.id, invoice.invoiceId))) {
      // Only reachable if the column was already set, which cannot happen for a
      // row created two statements ago — so this is a bug, not a race, and it
      // must not be swallowed: the webhook would reject every delivery for it.
      throw new Error(
        `StartCheckout: could not record the gateway reference for transaction ${transaction.id}`
      );
    }

    return {
      invoiceUrl: invoice.invoiceUrl,
      subscriptionId: subscription.id,
      transactionId: transaction.id,
    };
  }
}
