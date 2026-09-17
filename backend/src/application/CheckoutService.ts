import type {
  MembershipRepository, PaymentGateway, PaymentRepository,
  SubscriptionRepository, TierRepository, EventBus,
} from "../domain/ports.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";

export const PAYMENT_METHODS = [
  { id: "qris", name: "QRIS", note: "Bayar pakai aplikasi bank atau e-wallet apa saja" },
  { id: "ewallet", name: "E-Wallet", note: "GoPay, OVO, DANA, ShopeePay" },
  { id: "va", name: "Virtual Account", note: "BCA, Mandiri, BNI, BRI" },
  { id: "card", name: "Kartu Debit/Kredit", note: "Visa & Mastercard" },
] as const;

export class CheckoutService {
  constructor(
    private readonly tiers: TierRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly payments: PaymentRepository,
    private readonly memberships: MembershipRepository,
    private readonly gateway: PaymentGateway,
    private readonly events: EventBus,
  ) {}

  listTiers(communityId: string) { return this.tiers.listForCommunity(communityId); }
  paymentMethods() { return PAYMENT_METHODS; }

  /**
   * Creates real subscription + payment rows, then asks the gateway to charge.
   * With MockPaymentGateway the charge returns "paid" immediately (matching the
   * mockup). With a real gateway it returns "pending" + a redirectUrl and the
   * membership stays pending until POST /webhooks/payment confirms it — no code
   * here changes for that case.
   */
  async subscribe(communityId: string, userId: string, input: { tierId: string; method: string }) {
    if (!PAYMENT_METHODS.some((m) => m.id === input.method)) {
      throw new ValidationError(`Metode pembayaran tidak dikenal: ${input.method}`);
    }

    const tier = await this.tiers.findById(input.tierId);
    if (!tier || tier.communityId !== communityId) throw new NotFoundError("Tier");

    const subscription = await this.subscriptions.create({
      communityId, userId, tierId: tier.id, status: "pending",
    });

    const charge = await this.gateway.charge({
      amountCents: tier.priceCents,
      method: input.method,
      reference: subscription.id,
    });

    await this.payments.create({
      subscriptionId: subscription.id,
      amountCents: tier.priceCents,
      method: input.method,
      status: charge.status,
      gatewayRef: charge.gatewayRef,
    });

    const confirmed = charge.status === "paid";
    if (confirmed) await this.activate(subscription.id, communityId, userId, tier.id);

    return {
      subscriptionId: subscription.id,
      status: charge.status,
      redirectUrl: charge.redirectUrl,
      tier: { id: tier.id, name: tier.name, priceCents: tier.priceCents },
    };
  }

  private async activate(subscriptionId: string, communityId: string, userId: string, tierId: string) {
    await this.subscriptions.markActive(subscriptionId);
    await this.memberships.upsert({ communityId, userId, role: "member", status: "active", tierId });
  }

  /** Gateway callback. Idempotent: a replayed webhook must not double-activate. */
  async confirmPayment(input: {
    gatewayRef: string; status: "paid" | "failed";
    communityId: string; userId: string; tierId: string;
  }) {
    const payment = await this.payments.findByGatewayRef(input.gatewayRef);
    if (!payment) throw new NotFoundError("Pembayaran");

    await this.payments.markStatus(payment.id, input.status);
    if (input.status === "paid") {
      await this.activate(payment.subscriptionId, input.communityId, input.userId, input.tierId);

      // Two events for one fact, because they are addressed to opposite sides of
      // it: the buyer learns their payment went through, the community's staff
      // learn they have a new member.
      await this.events.emit({
        type: "payment.confirmed",
        userId: input.userId,
        communityId: input.communityId,
        tierId: input.tierId,
        paymentId: payment.id,
      });
      await this.events.emit({
        type: "member.joined",
        communityId: input.communityId,
        memberId: input.userId,
        tierId: input.tierId,
      });
    }
    return { ok: true };
  }
}
