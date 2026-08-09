import { ConflictError, NotFoundError } from "../errors";
import { isConnectedPaymentAccount } from "../../domain/payment-account";
import { isInsideRenewalWindow } from "../../domain/renewal-schedule";
import type { ClockPort } from "../ports/clock.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { MembershipTierRepositoryPort } from "../ports/membership-tier-repository.port";
import type { MemberRepositoryPort } from "../ports/member-repository.port";
import type {
  SubscriptionRecord,
  SubscriptionRepositoryPort,
} from "../ports/subscription-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import { VISIBLE_STATUSES } from "./get-public-community";

/**
 * The `subscription.status` a late member sits in. Always renewable — see `isRenewable`.
 */
const PAST_DUE = "past_due";

export class StartCheckout {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly tiers: MembershipTierRepositoryPort,
    private readonly members: MemberRepositoryPort,
    private readonly subscriptions: SubscriptionRepositoryPort,
    private readonly creators: CreatorRepositoryPort,
    private readonly payments: PaymentProviderPort,
    /**
     * Phase 5. Injected rather than read from `Date.now()` because this use-case now
     * makes a TIME-DEPENDENT decision: whether a member who already holds this tier is
     * renewing (inside the reminder window) or double-buying. A `Date.now()` here would
     * make the window's boundary — an Asia/Jakarta day, three days out — untestable, and
     * that boundary decides whether a member can act on their own reminder.
     */
    private readonly clock: ClockPort,
    /**
     * `appBaseUrl` is the public origin of `apps/web`, with no trailing slash —
     * see `resolveAppBaseUrl` in bootstrap.ts. It exists so this use-case can
     * build the URL the provider returns the payer to; it is configuration, not
     * a port, which is why it arrives as a plain value rather than behind an
     * interface.
     */
    private readonly config: { appBaseUrl: string }
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
    //
    // `isConnectedPaymentAccount`, not truthiness: since Task 7,
    // `CreatePaymentAccount` claims this column with a sentinel BEFORE it calls
    // Xendit, so a truthy value is not necessarily an account. Handing the
    // sentinel to `createInvoice` as `for_account_id` would charge a member
    // against an account that does not exist at the provider — a half-provisioned
    // creator must read as "not ready yet", which is exactly what it is.
    //
    // Bound to a local rather than tested in place so the type predicate actually
    // narrows it to `string` for the `forAccountId` below — narrowing does not
    // follow a `creator?.x ?? null` expression back to the property.
    const forAccountId = creator?.xenditAccountId ?? null;
    if (!isConnectedPaymentAccount(forAccountId)) {
      throw new ConflictError("this community is not ready to accept payments yet");
    }

    const member = await this.members.findOrCreateByWhatsappNumber({
      whatsappNumber: input.payerWhatsappNumber,
      name: input.payerName,
    });

    // RENEWAL OR DOUBLE-BUY? Decided BEFORE the invoice exists, which is the only
    // place a purchase can be refused for free.
    //
    // A member who already holds this tier and pays again for nothing used to be
    // charged: `markPaid` returned `superseded`, the new subscription was `cancelled`,
    // no `grant_access` outbox row was enqueued — so no WhatsApp message was sent AT
    // ALL — and the status page they were redirected to read `cancelled`. Money in,
    // nothing out, and the member never told why. That refusal stays.
    //
    // But Phase 3's version refused EVERY member who held an active subscription,
    // including the one who had just been sent a `pre_3d` reminder asking them to
    // renew. The reminder whose entire purpose is "renew without ever losing access"
    // pointed at a checkout that answered 409. A member inside their renewal window is
    // not double-buying; they are doing exactly what we asked.
    //
    // So the rule is `isInsideRenewalWindow`, read from the same domain module the
    // reminder schedule uses, and the window is therefore the same one by construction:
    // if we asked you to renew, the link works. A member with weeks to go still gets
    // the 409, because paying then really does buy them nothing.
    //
    // The `superseded` path stays as the backstop for the genuine race (two submits
    // inside the same instant, which this read cannot see).
    const current = await this.subscriptions.findCurrentSubscriptionForTier(member.id, tier.id);
    if (current !== null && !this.isRenewable(current)) {
      throw new ConflictError(
        "you already have an active membership for this tier. If you have not received " +
          "your group invite, contact the community owner — paying again would not send it."
      );
    }

    // THE SAME ROW when this is a renewal. A renewal updates the subscription it
    // renews — `markPaid` advances `next_billing_date`, clears the grace deadline and
    // releases the period's reminder claims — and creating a second row instead would
    // activate it alongside the first, which stays `past_due` for the churn pass to
    // revoke. So the member would pay and then lose access anyway. See the
    // `subscription_member_tier_active_unique` comment in db/schema.ts.
    const subscription =
      current ??
      (await this.subscriptions.createPending({
        memberId: member.id,
        tierId: tier.id,
      }));
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
      forAccountId,
      // Closes the loop the browser cannot: `CheckoutPage` hands the payer to
      // the provider and the provider hands them back HERE, to the confirmation
      // page Task 9 built. Built from the CANONICAL slug on the community record
      // rather than `input.slug`, so a caller that reached this row by some other
      // spelling still gets a URL that resolves.
      successRedirectUrl: this.subscriptionStatusUrl(community.slug, subscription.id),
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

  /**
   * Whether an existing subscription may be RENEWED by this checkout, rather than
   * refused as a purchase of something the member already has.
   *
   * `past_due` always may: the member is late, and taking their money is the entire
   * point of the reminders they have been receiving.
   *
   * `active` may only inside the reminder window. `next_billing_date` is nullable, and
   * "no due date" must never read as "due now" — nothing writes that state today
   * (activation always sets one), but the column allows it and a null would otherwise
   * fall through to a renewal of a period with no end.
   */
  private isRenewable(current: SubscriptionRecord): boolean {
    // NOT DEAD CODE, THOUGH DELETING IT LEAVES THE WHOLE SUITE GREEN. The final
    // whole-branch review checked: this branch is an EQUIVALENT MUTANT, because a
    // `past_due` row always has a due date in the past, so the window check below
    // returns true for it anyway. It is kept because it states the RULE — a late member
    // may always pay, whatever the reminder schedule happens to be — while the window is
    // a schedule that can change. Narrow the window to "the day before the due date" and
    // the two stop agreeing; without this line, that change would silently start refusing
    // every overdue member's payment, and no test would say so.
    if (current.status === PAST_DUE) return true;
    if (current.nextBillingDate === null) return false;
    // UTC midnight of the day the column names, i.e. 07:00 WIB — safely inside the
    // intended Asia/Jakarta day, which is the frame `isInsideRenewalWindow` compares in.
    return isInsideRenewalWindow(new Date(current.nextBillingDate), this.clock.now());
  }

  /**
   * Must stay in step with the `/c/:slug/status/:subscriptionId` route in
   * `apps/web/src/App.tsx`. Both segments are encoded: the slug is generated by
   * `domain/slug.ts` and the id is a uuid, so neither should need it today — but
   * this string is handed to a third party who redirects a browser to it, and
   * that is not the place to rely on an invariant holding elsewhere.
   */
  private subscriptionStatusUrl(slug: string, subscriptionId: string): string {
    return (
      `${this.config.appBaseUrl}/c/${encodeURIComponent(slug)}` +
      `/status/${encodeURIComponent(subscriptionId)}`
    );
  }
}
