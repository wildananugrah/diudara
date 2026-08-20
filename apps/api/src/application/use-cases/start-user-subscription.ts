import { ConflictError, NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import { isConnectedPaymentAccount } from "../../domain/payment-account";
import { userSubscriptionExternalId } from "../../domain/user-payment";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserTierRepositoryPort } from "../ports/user-tier-repository.port";
import type { UserPayoutRepositoryPort } from "../ports/user-payout-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";

export interface StartUserSubscriptionResult {
  /** Where the browser is sent to pay. */
  invoiceUrl: string;
  subscriptionId: string;
  transactionId: string;
  /**
   * The namespaced id this invoice carries at the provider, returned so a
   * caller (and this suite) can see the shape Task 7's webhook routes on
   * without reading the provider's dashboard. It is derived from
   * `transactionId`, which is already in this response — it discloses nothing
   * new.
   */
  externalId: string;
}

/**
 * `POST /users/:handle/subscribe` — buying a membership from a person, spec §6.
 *
 * This is the moment money actually moves in Phase 5a, and two things about it
 * are load-bearing enough to state before the code says them.
 *
 * **THE PAYOUT GATE IS `isConnectedPaymentAccount`, NEVER TRUTHINESS.**
 * `app_user.xendit_account_id` has three states — NULL, the
 * `XENDIT_ACCOUNT_PROVISIONING` sentinel, and a real account id — and the
 * sentinel is TRUTHY. `if (owner.xenditAccountId)` therefore passes for a
 * half-finished, KYC-pending connection, and this use case would then send
 * `for_account_id: "provisioning:in-progress"` — a literal English phrase where
 * a 24-character Xendit object id belongs — on a live payment request, charging
 * a buyer against an account that does not exist at the provider. `StartCheckout`
 * shipped exactly that bug for the creator flow and it was found by a mutation
 * sweep, not by a test; `ConnectUserPayout` and `ManageUserTiers` share this same
 * predicate rather than re-deriving it.
 *
 * **THE ROWS ARE CREATED BEFORE THE PROVIDER IS CALLED.** A failed provider call
 * then leaves a `pending` subscription and a `pending` transaction — recoverable,
 * inspectable, and harmless, since nothing was charged. The reverse order leaves
 * a live invoice at Xendit whose `external_id` refers to no row at all, and the
 * webhook that eventually arrives for it has nothing to resolve: a member who
 * paid could not be activated by anything. `StartCheckout` records the same
 * ordering for the same reason.
 *
 * The `external_id` is namespaced (`domain/user-payment.ts`): Xendit delivers ONE
 * webhook stream and the community handler resolves its own invoices by treating
 * `external_id` as a bare `transaction.id` uuid, so a user-subscription invoice
 * has to be distinguishable WITHOUT GUESSING.
 *
 * Untouched by all of this: `subscription`, `transaction`, `member` and
 * `membership_tier` — the tables behind `/dashboard/*`. This is a parallel flow
 * over `user_subscription`/`user_transaction`, not a generalisation of that one.
 */
export class StartUserSubscription {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly tiers: UserTierRepositoryPort,
    private readonly payouts: UserPayoutRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly payments: PaymentProviderPort,
    /**
     * `appBaseUrl` is the public origin of `apps/web`, with no trailing slash —
     * see `resolveAppBaseUrl` in bootstrap.ts. Configuration, not a port, which
     * is why it arrives as a plain value; same shape `StartCheckout` takes it in.
     */
    private readonly config: { appBaseUrl: string }
  ) {}

  async execute(input: {
    /** The signed-in buyer. The route takes it from the session, never the body. */
    subscriberId: string;
    /** The seller's handle, as it appears in the profile URL. */
    handle: string;
    tierId: string;
  }): Promise<StartUserSubscriptionResult> {
    // `normalizeHandle` for the same forgiveness `GetUserProfile` gives: the
    // `@` is a web URL convention, and a client that sends it should not get a
    // 404 for it.
    const owner = await this.users.findByHandle(normalizeHandle(input.handle));
    if (!owner) {
      throw new NotFoundError("user not found");
    }

    // Refused HERE and not left to `user_subscription_no_self`. The CHECK
    // constraint is the backstop and it is doing its job, but it surfaces as a
    // driver error — a 500 — and "500" is not something a person can act on.
    if (owner.id === input.subscriberId) {
      throw new ConflictError(
        "Anda tidak dapat berlangganan ke diri sendiri. Bagikan tautan profil Anda " +
          "agar orang lain dapat menjadi anggota."
      );
    }

    const tier = await this.tiers.findById(input.tierId);
    // A tier belonging to somebody else is a 404, not a 403: the same choice
    // `ManageUserTiers.deactivate` makes, so probing another owner's tier ids
    // teaches a caller nothing. It is also a correctness gate, not only a
    // privacy one — charging THIS owner's account for THAT owner's tier is
    // precisely what the composite foreign key exists to make impossible, and
    // this refuses it before the row is even attempted.
    if (!tier || tier.ownerId !== owner.id) {
      throw new NotFoundError("tier not found");
    }
    if (!tier.isActive) {
      throw new ConflictError(
        "Tingkatan keanggotaan ini sudah tidak ditawarkan lagi. Pilih tingkatan lain " +
          "yang masih tersedia di profil kreator ini."
      );
    }

    const payout = await this.payouts.findPayoutAccount(owner.id);
    if (!payout) {
      // Unreachable while `user_tier.owner_id` references `app_user` — the
      // owner was just read above — but not assumed away. English, like every
      // other `NotFoundError` call site in this codebase.
      throw new NotFoundError("user not found");
    }
    // Bound to a local rather than tested in place, so the type predicate
    // actually narrows it to `string` for `forAccountId` below — narrowing does
    // not follow a property access back through the object.
    const forAccountId = payout.xenditAccountId;
    if (!isConnectedPaymentAccount(forAccountId)) {
      // NOT `if (forAccountId)`. See this class's docstring: the sentinel is
      // truthy, and a truthy read here is what would put
      // `for_account_id: "provisioning:in-progress"` on the wire.
      throw new ConflictError(
        "Kreator ini belum siap menerima pembayaran. Minta mereka menghubungkan akun " +
          "pembayaran di Pengaturan terlebih dahulu."
      );
    }

    // The CLEAN refusal of a double purchase. `user_subscription_one_active`
    // (the partial unique index) would reject the second ACTIVE row anyway, but
    // only at the moment Task 7's webhook tried to activate it — by which point
    // the buyer has already paid for something they already hold. Refusing here
    // costs one indexed read and is the only place this can be refused for free.
    // The index stays the backstop for the genuine race this read cannot see.
    const existing = await this.subscriptions.findActiveFor(input.subscriberId, owner.id);
    if (existing) {
      throw new ConflictError(
        "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah " +
          "masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."
      );
    }

    const subscriber = await this.users.findById(input.subscriberId);
    if (!subscriber) {
      // The caller authenticated as this id one middleware ago, so this is
      // defensive rather than expected.
      throw new NotFoundError("user not found");
    }

    // ---- Everything below this line changes state. Rows FIRST, provider last.
    const subscription = await this.subscriptions.create({
      subscriberId: input.subscriberId,
      tierId: tier.id,
      // DENORMALISED, and taken from the TIER's owner rather than from the
      // handle lookup, so the value written is the one the composite foreign
      // key checks. They are equal — the tier was just matched against
      // `owner.id` — and taking it from here keeps them equal by construction.
      ownerId: tier.ownerId,
    });
    const transaction = await this.subscriptions.createTransaction({
      userSubscriptionId: subscription.id,
      // OUR figure, read from the tier, never anything the client sent: it is
      // what Task 7's webhook compares the provider's claimed amount against.
      amount: tier.priceAmount,
    });

    const externalId = userSubscriptionExternalId(transaction.id);
    const invoice = await this.payments.createInvoice({
      externalId,
      amount: tier.priceAmount,
      description: `${owner.displayName} — ${tier.name}`,
      payerName: subscriber.displayName,
      // `app_user.whatsapp_number` is NULLABLE and this field is not: a personal
      // account can be created with an email alone. The provider uses it to
      // reach the payer about their own invoice, so an empty string is the
      // honest "we do not have one" — never a placeholder that would send
      // somebody else's receipt to a number we made up.
      payerWhatsappNumber: subscriber.whatsappNumber ?? "",
      forAccountId,
      successRedirectUrl: this.profileUrl(owner.handle),
    });

    // The webhook's ANCHOR, and the reason this is a second write rather than a
    // field on `createTransaction`: the invoice id does not exist until the call
    // above returns, and that call must not happen first. Without this,
    // `provider_event_id` — derived from the delivered `body.id` — is checked
    // against nothing, so anyone able to reach the webhook could mint a fresh
    // event id at will and walk past the UNIQUE constraint. The community
    // handler measured that hole: 12 concurrent deliveries with 12 distinct
    // `body.id`s all returned 200 and all activated.
    if (!(await this.subscriptions.attachGatewayReference(transaction.id, invoice.invoiceId))) {
      // Only reachable if the column was already set, which cannot happen for a
      // row created two statements ago — so this is a bug, not a race, and
      // swallowing it would leave a transaction the webhook must refuse to
      // verify for the rest of its life.
      throw new Error(
        "StartUserSubscription: could not record the gateway reference for transaction " +
          transaction.id
      );
    }

    return {
      invoiceUrl: invoice.invoiceUrl,
      subscriptionId: subscription.id,
      transactionId: transaction.id,
      externalId,
    };
  }

  /**
   * Where the provider returns the payer's browser after a successful payment.
   *
   * The owner's own profile — `apps/web`'s `/:handleParam` route, which renders
   * a profile only for a param starting with `@`. Phase 5a has no status page
   * for a user subscription (spec §9's honest limitation: nothing renews or
   * expires one yet), and the profile is where the membership becomes visible
   * once Task 7's webhook activates it. Leaving `successRedirectUrl` off would
   * strand a member on Xendit's own receipt with no way back — the exact defect
   * `CreateInvoiceInput.successRedirectUrl` was made required to prevent.
   *
   * Built from the CANONICAL handle on the owner's record rather than from
   * `input.handle`, so a caller who reached this row by some other spelling
   * still gets a URL that resolves. Encoded because this string is handed to a
   * third party who redirects a browser to it, which is not the place to rely on
   * `HANDLE_PATTERN` holding elsewhere.
   */
  private profileUrl(handle: string): string {
    return `${this.config.appBaseUrl}/@${encodeURIComponent(handle)}`;
  }
}
