import { ConflictError, NotFoundError, ServiceUnavailableError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import { isConnectedPaymentAccount } from "../../domain/payment-account";
import { userSubscriptionExternalId } from "../../domain/user-payment";
import { membershipStanding } from "./is-member-of";
import type { ClockPort } from "../ports/clock.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserTierRepositoryPort } from "../ports/user-tier-repository.port";
import type { UserPayoutRepositoryPort } from "../ports/user-payout-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";
import type { UserPurchaseUnitOfWorkPort } from "../ports/user-purchase-unit-of-work.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";

export interface StartUserSubscriptionResult {
  /**
   * Where the browser is sent to pay. Absent for a FREE tier ONLY — no
   * invoice is ever opened for one, because nothing is owed (spec §2.4).
   * Present, and required to be a string, for every paid result.
   */
  invoiceUrl?: string;
  subscriptionId: string;
  /** Absent for a FREE tier — see `invoiceUrl`: no transaction row is created for one either. */
  transactionId?: string;
  /**
   * The namespaced id this invoice carries at the provider, returned so a
   * caller (and this suite) can see the shape Task 7's webhook routes on
   * without reading the provider's dashboard. It is derived from
   * `transactionId`, which is already in this response — it discloses nothing
   * new. Absent exactly when `transactionId` is.
   */
  externalId?: string;
}

/**
 * `POST /users/:handle/subscribe` — buying a membership from a person, spec §6.
 *
 * This is the moment money actually moves, and several things about it are
 * load-bearing enough to state before the code says them.
 *
 * **A LAPSED MEMBERSHIP IS RETIRED HERE, AND THAT IS WHAT RENEWAL IS** (Phase
 * 5b, Task 2). Nothing in this system charges anybody twice on its own — the
 * Xendit adapter has two operations and no tokenisation — so "renew" means "buy
 * again", and the only thing that stood in the way was the buyer's own expired
 * row: still `status = 'active'`, still holding
 * `user_subscription_one_active`'s slot, refused by the guard below forever. A
 * member whose period has ended now presses the button once and gets a fresh
 * checkout. The retirement and the pending claim commit TOGETHER — see
 * `UserPurchaseUnitOfWorkPort` — because a retirement that committed alone and
 * a claim that then failed would leave that person with neither an active
 * membership nor a pending checkout.
 *
 * **FREE IS DECIDED BY `tier.priceAmount`, NEVER A SECOND FLAG** (spec §2.4,
 * Phase "free memberships" Task 4). `user_subscription.kind` is written from
 * the tier's own price at the moment this executes — there is deliberately no
 * `isFree` input a caller could send that disagrees with it. A free request
 * takes a SEPARATE, shorter path: no payout account is required (no money
 * moves — the same rule Task 3 drew for *creating* a free tier), no
 * `retireExpired`, no `PaymentProviderPort` call, no transaction row, no
 * invoice. It still runs the SAME status-only "already a member" guard the
 * paid path uses (`findActiveFor` below), worded by the same
 * `membershipStanding`-driven sentence — see that guard's own comment for why
 * a LAPSED paid row is refused here too, rather than quietly handed a free
 * membership: nothing in this phase renews one INTO a free tier, so the
 * refusal is spec §9's accepted limitation, but the SENTENCE must say the
 * membership ended, never "you are already an active member".
 *
 * **A PAID TIER WITH NO PAYMENT PROVIDER IS REFUSED, NOT SILENTLY FREED.**
 * `payments` is `PaymentProviderPort | null` — `null` on a box with no
 * provider configured at all — and `bootstrap.ts` now constructs this use
 * case UNCONDITIONALLY, because a free request needs no provider to exist.
 * The decision that used to be made at BOOT time (build this class, or
 * don't) is now made per REQUEST, at the tier: a free tier proceeds
 * regardless of `payments`, and only a paid tier with `payments === null`
 * throws `ServiceUnavailableError`. `routes/users.ts` no longer 503s every
 * subscribe request on such a box — only a paid one now reaches that answer.
 *
 * **THE PAYOUT GATE IS `isConnectedPaymentAccount`, NEVER TRUTHINESS —
 * AND ONLY FOR A PAID TIER.** `app_user.xendit_account_id` has three states —
 * NULL, the `XENDIT_ACCOUNT_PROVISIONING` sentinel, and a real account id —
 * and the sentinel is TRUTHY. `if (owner.xenditAccountId)` therefore passes
 * for a half-finished, KYC-pending connection, and this use case would then
 * send `for_account_id: "provisioning:in-progress"` — a literal English
 * phrase where a 24-character Xendit object id belongs — on a live payment
 * request, charging a buyer against an account that does not exist at the
 * provider. `StartCheckout` shipped exactly that bug for the creator flow
 * and it was found by a mutation sweep, not by a test; `ConnectUserPayout`
 * and `ManageUserTiers` share this same predicate rather than re-deriving
 * it.
 *
 * **THE ROWS ARE CREATED BEFORE THE PROVIDER IS CALLED.** A failed provider call
 * then leaves a `pending` subscription and a `pending` transaction — recoverable,
 * inspectable, and harmless, since nothing was charged. The reverse order leaves
 * a live invoice at Xendit whose `external_id` refers to no row at all, and the
 * webhook that eventually arrives for it has nothing to resolve: a member who
 * paid could not be activated by anything. `StartCheckout` records the same
 * ordering for the same reason.
 *
 * **A SECOND TAP MUST NOT MINT A SECOND INVOICE.** Refusing an ACTIVE membership
 * (spec §6) does not cover the buyer who taps "Jadi anggota" twice: nothing
 * dedupes a PENDING one, so two live invoices used to open, and paying both
 * charged one person twice for one membership — the second activation hitting
 * `user_subscription_one_active` as a 500 with the provider retrying behind it,
 * and 5a has no refund path. So a pending checkout for this pair is handed BACK
 * rather than replaced. See `findPendingCheckout`.
 *
 * **AND THE DATABASE ARBITRATES THAT, NOT A READ.** The first version of this
 * refusal read for a pending checkout and then created one, which two concurrent
 * taps pass together: a re-review fired two simultaneous requests at the real
 * database and got two live invoices, two subscriptions and two transactions for
 * one pair in one run out of five. A double tap on a phone is CONCURRENT. So the
 * INSERT is the claim — `user_subscription_one_pending` — and the loser is
 * routed into the reuse path by the conflict, never by a read. See
 * `claimPending` (whose arbitration is `ON CONFLICT DO NOTHING` and must stay
 * that, now that it runs inside a transaction), and `releaseClaim` for why ANY
 * failure between the claim and the invoice reference must give the claim
 * back.
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
    /**
     * Retirement + claim, atomically. See `UserPurchaseUnitOfWorkPort`.
     */
    private readonly purchase: UserPurchaseUnitOfWorkPort,
    /**
     * `null` EXACTLY when this box has no payment provider configured at all
     * — see `Dependencies.payments`'s own docstring in `bootstrap.ts`. No
     * longer gates whether this class can be CONSTRUCTED (Task 4 of "free
     * memberships"): `bootstrap.ts` builds it unconditionally now, because a
     * free tier never touches this field, and only a PAID tier's `execute`
     * call throws `ServiceUnavailableError` when it is `null`. See this
     * class's own docstring for the full reasoning.
     */
    private readonly payments: PaymentProviderPort | null,
    /**
     * Only to word the refusal below, never to decide one. A lapsed
     * subscription and a live one are refused identically — see the
     * `findActiveFor` guard — but they are not the same news, and telling a
     * lapsed member "you are already an active member" is simply false. Read
     * through the port for the reason `ClockPort` exists: the answer changes
     * at an instant, and an instant read inline is one no test can stand on.
     */
    private readonly clock: ClockPort,
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

    // Read BEFORE either branch below, and BEFORE the unit of work opens —
    // this position is load-bearing twice over, for the free path exactly as
    // much as the paid one.
    //
    // FIRST, IT IS WHAT MAKES THE IDS SAFE. `retireExpired` skips uuid-shape
    // validation, matching `activate`/`cancel`'s precedent for internal callers
    // — which Task 1's review allowed on the condition that this call site
    // resolve both ids through a prior lookup. So the owner id below comes off
    // the row `findByHandle` returned and the subscriber id off the row this
    // read returns; a raw session or route value reaching that query would turn
    // a malformed id into an unhandled 500 on a path a buyer reaches, instead of
    // the clean 404 below.
    //
    // SECOND, IT MUST NOT HAPPEN INSIDE THE TRANSACTION. This repository is
    // bound to the POOL, so calling it from inside `purchase.run` would check
    // out a second connection while the first is still held. The pool is ten
    // wide; ten concurrent buyers each holding a transaction and each waiting
    // for a second connection is a deadlock nothing resolves but a timeout. See
    // `UserPurchaseRepositories.subscriptions`.
    const subscriber = await this.users.findById(input.subscriberId);
    if (!subscriber) {
      // The caller authenticated as this id one middleware ago, so this is
      // defensive rather than expected.
      throw new NotFoundError("user not found");
    }

    // Free is decided by the PRICE, not by a second flag that could disagree
    // with it (spec §2.4) — `user_subscription.kind` is derived here, never
    // taken from client input.
    if (tier.priceAmount === 0) {
      // A FREE tier needs no payout account — no money moves, so there is
      // nothing to route to a sub-account. Task 3 drew the identical line for
      // *creating* a free tier; this is the same rule at request time. The
      // payout check and the `payments === null` refusal below are therefore
      // never reached on this branch.
      //
      // DELIBERATELY NO `retireExpired` HERE. Retirement is what turns a
      // lapsed PAID row into a fresh purchase — 5b's "renewal is buy again" —
      // but a free request has nothing to buy again INTO: this phase gives a
      // free membership no renewal path of its own (spec §9), so a lapsed
      // paid row is left exactly as `retireExpired` would have found it,
      // still `status = 'active'`, and the guard right below still SEES it.
      //
      // THE GUARD ITSELF IS UNCHANGED — `findActiveFor` is the same
      // status-only read the paid path's transaction uses below, and
      // `refuseExistingMembership` is the same two-sentence refusal. A
      // former paying member whose row sits active-but-expired is refused a
      // free request too; that is spec §9's accepted limitation, not a new
      // one. What is NOT acceptable is the SENTENCE — see that method's own
      // docstring for why it must say the membership ended, never "you are
      // already an active member".
      const existing = await this.subscriptions.findActiveFor(subscriber.id, owner.id, null /* personal membership — see the port's note on this argument */);
      if (existing) {
        this.refuseExistingMembership(existing);
      }
      // `claimPending`, NOT `create` — the SAME mechanism the paid path below
      // uses, for the same reason. The pending slot is arbitrated by the partial
      // unique index `user_subscription_one_pending`, so a plain insert makes a
      // SECOND request raise 23505 and reach the route as a 500. Tapping "Minta
      // jadi anggota" twice on a slow connection is the most ordinary thing a
      // user does — and the in-memory fakes these use-case tests run against
      // have no unique index, so nothing here could ever have noticed. It was
      // caught by a route-level test against the real database.
      //
      // `created: false` means this pair already holds the pending slot. The
      // honest answer is the request they already have, so a second tap is
      // idempotent rather than an error.
      const claim = await this.subscriptions.claimPending({
        subscriberId: subscriber.id,
        tierId: tier.id,
        // DENORMALISED from the TIER's own owner, exactly as the paid path's
        // `claimPending` call below takes it — see that call site's comment
        // for why this keeps the two equal by construction.
        ownerId: tier.ownerId,
        kind: "free",
      });
      // WHOLE-BRANCH REVIEW, M-1. `user_subscription_one_pending` is scoped to
      // (subscriber, owner) and says NOTHING about `kind`, so this claim can
      // conflict with a PENDING PAID CHECKOUT and hand that row back. Returning
      // it as though a free request had been made was silent, total failure:
      // the caller got 201, the profile rendered "Menunggu persetujuan", the
      // owner's queue (`kind = 'free'`) stayed empty, and the requester waited
      // for an approval nobody had been asked for — while their real, unpaid
      // invoice sat behind it.
      //
      // The honest answer names the open invoice. `created === false` with a
      // free row is the idempotent second tap Task 4 built and is still fine.
      if (!claim.created && claim.subscription.kind !== "free") {
        throw new ConflictError(
          "Anda punya pembayaran yang belum selesai untuk kreator ini. Selesaikan atau " +
            "batalkan dulu sebelum meminta keanggotaan gratis."
        );
      }
      // No invoice, no transaction row, no provider call: nothing is owed for
      // a free membership, so none of the paid machinery below this branch
      // ever runs for one.
      return { subscriptionId: claim.subscription.id };
    }

    if (this.payments === null) {
      // The decision moved from BOOT time to the TIER (Task 4 of "free
      // memberships"): `bootstrap.ts` now constructs this class
      // unconditionally, since a free tier needs no provider at all. Only a
      // PAID tier reaches this line, and only a PAID tier is refused here.
      throw new ServiceUnavailableError("pembayaran belum tersedia di server ini");
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

    // `subscriber` was already read above, before the free/paid branch — see
    // that read's own comment for why its position is load-bearing.

    // ---- RETIRE, THEN GUARD, THEN CLAIM — ONE TRANSACTION.
    //
    // **THE RETIREMENT IS WHAT MAKES RENEWAL POSSIBLE AT ALL.** There is no
    // recurring charge anywhere in this system, so 5b's renewal is "buy again",
    // and the only thing standing between a lapsed member and a second
    // membership is their old row still sitting at `status = 'active'` holding
    // `user_subscription_one_active`'s slot. `retireExpired` moves it — and only
    // it: the WHERE clause is `status = 'active' AND current_period_end <= now`,
    // so a membership still inside its paid period is untouched and is refused
    // by the guard below exactly as before.
    //
    // **THAT IS ALSO WHY THE GUARD DID NOT HAVE TO CHANGE.** It is still
    // status-only, and it still refuses everything it sees; what changed is that
    // the lapsed row is no longer there for it to see. Teaching the guard about
    // periods instead is the fix 5a explicitly ruled against — a row that still
    // holds the unique-index slot would then reach a purchase that collides at
    // activation time, which is money taken and no membership granted.
    //
    // **AND BOTH WRITES COMMIT TOGETHER.** A retirement that committed on its
    // own and a claim that then failed would leave this person holding neither
    // an active membership nor a pending checkout. See
    // `UserPurchaseUnitOfWorkPort`, and `claimPending` for the one thing that
    // had to change to survive being called in here.
    const claim = await this.purchase.run(async ({ subscriptions }) => {
      await subscriptions.retireExpired(
        subscriber.id,
        owner.id,
        null /* personal membership — see the port's note on this argument */,
        this.clock.now()
      );

      // The CLEAN refusal of a double purchase. `user_subscription_one_active`
      // (the partial unique index) would reject the second ACTIVE row anyway, but
      // only at the moment Task 7's webhook tried to activate it — by which point
      // the buyer has already paid for something they already hold. Refusing here
      // costs one indexed read and is the only place this can be refused for free.
      // The index stays the backstop for the genuine race this read cannot see.
      //
      // **STATUS-ONLY, AND IT MUST STAY STATUS-ONLY.** `findActiveFor` does not
      // look at `current_period_end`, so it refuses a LAPSED row too — and
      // narrowing it to "active and still in period" is the obvious fix that is
      // the dangerous one: a lapsed row still holds `user_subscription_one_active`'s
      // slot, so letting one past this guard puts the purchase on a collision
      // course with that index at activation time. That converts a button that
      // refuses into money taken and no membership granted. Task 8's re-review
      // established this; it is not up for rediscovery here.
      //
      // 5b did not narrow it and did not need to: `retireExpired` above has
      // already moved the lapsed row out of `active`, so this read no longer
      // SEES one. The guard kept its predicate; the row stopped matching it.
      const existing = await subscriptions.findActiveFor(subscriber.id, owner.id, null /* personal membership — see the port's note on this argument */);
      if (existing) {
        // See `refuseExistingMembership`'s own docstring for the full
        // "one refusal, two different pieces of news" reasoning — shared with
        // the free path above, which reaches this same method without ever
        // calling `retireExpired` first.
        //
        // WHICH BRANCH IS STILL REACHABLE HERE, ON THIS (PAID, POST-RETIRE)
        // PATH. The "member" one, for anybody still inside their paid period —
        // the ordinary refusal. The "ended" one now only for an `active` row
        // with a NULL `current_period_end` AND `kind = 'paid'`: `retireExpired`
        // just ran, and its predicate is `current_period_end <= now`, which
        // `NULL <= now` never satisfies — so that one shape survives the
        // retirement and lands here. It is unreachable through `activate`,
        // which always writes a period end, but it is the one shape that
        // grants nothing while still holding the unique-index slot, and
        // telling that person they are an active member would be false.
        this.refuseExistingMembership(existing);
      }

      // ---- Everything from here changes state. Rows FIRST, provider last.
      //
      // AND THE CLAIM IS FIRST OF ALL. `claimPending` INSERTS, and
      // `user_subscription_one_pending` is what decides whether this caller or
      // another one gets to open an invoice — never a read taken beforehand. Two
      // concurrent taps used to pass a read-then-write check together and open two
      // live invoices for one membership; measured on this endpoint, one run in
      // five. See the port's own docstring.
      return subscriptions.claimPending({
        subscriberId: subscriber.id,
        tierId: tier.id,
        // DENORMALISED, and taken from the TIER's owner rather than from the
        // handle lookup, so the value written is the one the composite foreign key
        // checks. They are equal — the tier was just matched against `owner.id` —
        // and taking it from here keeps them equal by construction.
        ownerId: tier.ownerId,
      });
    });
    // ---- The transaction has COMMITTED. Everything below is on the pool: the
    // provider call must never happen inside a database transaction, and
    // `createTransaction`/`attachGatewayReference` sit either side of it.
    if (!claim.created) {
      // Somebody else holds this pair's pending slot: the winner of a double
      // tap, or an earlier tap of our own that is still being paid.
      return this.resolveExistingCheckout(subscriber.id, owner.id, tier.id);
    }
    const subscription = claim.subscription;

    // ---- EVERYTHING FROM HERE TO THE RETURN IS GUARDED, not just the provider
    // call.
    //
    // The claim above is this pair's ONLY pending slot and nothing in 5a ever
    // clears one: no renewal pass, no cancel route, no operator path. So any
    // statement in here that throws without giving the claim back wedges this
    // buyer out of this creator PERMANENTLY — and invisibly, because
    // `findPendingCheckout` requires a non-null invoice url (correctly: that
    // predicate is what stops a failed provider call blocking the buyer), so
    // the row exists for `claimPending` and does not exist for
    // `resolveExistingCheckout`. Every later attempt then falls into the
    // TRANSIENT branch and is told to wait and try again, which can never work.
    //
    // Round 2 released the claim around `payments.createInvoice` alone, and the
    // final whole-branch review measured what the other two statements do:
    // one simulated connection reset on `attachGatewayReference` gave attempt 1
    // a 500 with an invoice already open at the provider, attempts 2 and 3 the
    // transient 409, and `findPendingCheckout → null` forever. `createTransaction`
    // is the same shape. Both write to the database, so both can fail the way a
    // dropped connection fails; neither was covered.
    //
    // The residue is the one round 2 already accepted: a `cancelled` row and a
    // possibly-orphaned invoice at the provider whose transaction carries no
    // gateway reference, which `settleUserSubscription` fails CLOSED on. That is
    // strictly better than a buyer who can never pay at all.
    try {
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
        // OMITTED, not empty, when this buyer has no number on file:
        // `app_user.whatsapp_number` is nullable (signup takes an email alone),
        // and absent is the documented "we do not have one" while `""` is a value
        // that still has to pass the provider's format validation. See
        // `CreateInvoiceInput.payerWhatsappNumber`.
        ...(subscriber.whatsappNumber === null
          ? {}
          : { payerWhatsappNumber: subscriber.whatsappNumber }),
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
      if (
        !(await this.subscriptions.attachGatewayReference(
          transaction.id,
          invoice.invoiceId,
          // Stored, not merely returned: it is what the second-tap guard above
          // hands back, and a url we did not keep is a url we would have to mint
          // a second invoice to reproduce.
          invoice.invoiceUrl
        ))
      ) {
        // Only reachable if the column was already set, which cannot happen for a
        // row created two statements ago — so this is a bug, not a race, and
        // swallowing it would leave a transaction the webhook must refuse to
        // verify for the rest of its life. Thrown INSIDE the guard, so the bug
        // costs one failed purchase rather than one buyer.
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
    } catch (err) {
      await this.releaseClaim(subscription.id);
      throw err;
    }
  }

  /**
   * ONE refusal, worded from TWO different pieces of news, and the row itself
   * is what says which — never a flag this call site chooses. Both are a 409
   * and neither creates anything; the guard that found `existing` is
   * untouched, only the sentence differs, because only the sentence used to
   * be wrong.
   *
   * Shared by the FREE path (Task 4 of "free memberships" — reached directly
   * off `findActiveFor`, no `retireExpired` in front of it) and the PAID
   * path's transaction (reached AFTER `retireExpired` has already run). Both
   * call sites hand this the same status-only row; only which shapes of row
   * can still be `existing` by the time either call site reaches it differs
   * — see each call site's own comment for that.
   *
   * Measured by Phase 5b's final whole-branch review: one billing cycle after
   * EVERY purchase, `IsMemberOf` (period-aware) answers `false` while this
   * guard (status-only) answers "refused" — so the profile rendered the
   * offer, this route answered "Anda sudah menjadi anggota aktif", which is
   * FALSE for that person, and the web advised a reload that re-rendered the
   * very same button. `MembershipView.viewerMembershipEnded` is what stops
   * the button being offered at all; this is what the route says when one is
   * pressed anyway, from a page that predates the answer.
   *
   * A FREE row with a NULL period takes the "member" branch, never "ended" —
   * `membershipStanding` checks `kind === "free"` before it ever looks at
   * `currentPeriodEnd`, because for a free membership a NULL period is not a
   * bug but the whole point (spec §3), and telling a free member their
   * membership has ended would be false. NEITHER sentence invites a retry
   * that cannot work, which is the loop `describeUploadFailure`'s own rewrite
   * forbids.
   */
  private refuseExistingMembership(existing: UserSubscriptionRow): never {
    throw new ConflictError(
      membershipStanding(existing, this.clock.now()) === "member"
        ? "Anda sudah menjadi anggota aktif kreator ini. Membayar lagi tidak menambah " +
          "masa aktif — jika Anda belum bisa melihat kontennya, hubungi kreator tersebut."
        : "Keanggotaan Anda untuk kreator ini sudah berakhir, dan perpanjangan belum " +
          "tersedia — jadi keanggotaan baru pun belum bisa dibeli. Hubungi kreator " +
          "tersebut jika Anda masih memerlukan akses."
    );
  }

  /**
   * What to answer a caller that did NOT win the pending claim.
   *
   * Reads the winner's invoice rather than opening a second one — the sequential
   * double tap's reuse path, reached from the concurrent one. Three outcomes:
   *
   *  - the winner's invoice exists and is for the same tier: hand it back, which
   *    is the ordinary "they tapped twice" case and creates nothing at all;
   *  - it exists and is for a DIFFERENT tier: refuse, because opening one would
   *    be the second invoice this whole mechanism prevents, and silently
   *    returning the other one would charge a price the buyer did not choose;
   *  - it does not exist YET: the winner is between its INSERT and its provider
   *    call, a window of milliseconds. Refuse transiently and say so — a
   *    checkout that FAILS anywhere releases the claim (see `releaseClaim`), so
   *    this state cannot outlive the attempt that created it and a second tap
   *    resolves it.
   */
  private async resolveExistingCheckout(
    subscriberId: string,
    ownerId: string,
    tierId: string
  ): Promise<StartUserSubscriptionResult> {
    const live = await this.subscriptions.findPendingCheckout(subscriberId, ownerId);
    if (live !== null && live.tierId === tierId) {
      return {
        invoiceUrl: live.invoiceUrl,
        subscriptionId: live.subscriptionId,
        transactionId: live.transactionId,
        externalId: userSubscriptionExternalId(live.transactionId),
      };
    }
    if (live !== null) {
      throw new ConflictError(
        "Pembayaran keanggotaan untuk kreator ini sedang diproses. Selesaikan dulu " +
          "pembayaran yang sudah dibuka, atau tunggu tagihannya kedaluwarsa sebelum " +
          "memilih tingkatan lain."
      );
    }
    throw new ConflictError(
      "Pembayaran Anda sedang disiapkan. Tunggu sebentar, lalu coba lagi — jangan " +
        "menekan tombol berkali-kali agar Anda tidak ditagih dua kali."
    );
  }

  /**
   * THE ONE THING THAT MUST HAPPEN WHEN ANY OF THAT FAILS: RELEASE THE CLAIM.
   *
   * The pending subscription is a claim on this pair's only pending slot. There
   * is no cancel route and no operator path, and until Phase 5b nothing expired
   * one either — so a failure that left the row `pending` wedged this buyer out
   * of this creator PERMANENTLY, for a purchase nobody ever charged them for.
   * Exactly the reasoning `ConnectUserPayout` records for
   * `abandonXenditAccountProvisioning`, whose sentinel has the identical hazard.
   *
   * Task 5's stale-pending sweep now clears such a row after two hours, so the
   * worst case is two hours rather than for ever — which is a backstop, not a
   * reason to skip this. Two hours is a long time to be unable to buy, and the
   * sweep only runs if the worker is up.
   *
   * **A `null` FROM `cancel` NO LONGER MEANS THE CLAIM IS STILL HELD** (final
   * review, m-2): `cancel` refuses to rewrite a TERMINAL row, so `null` also
   * covers "the sweep already ended this one". The slot is free in that case, so
   * the row is re-read before warning — a false "this buyer cannot start another
   * checkout" is worse than silence, because it is the line an operator acts on.
   *
   * The transaction row is deliberately NOT touched: it stays, with a null
   * gateway reference, as the inspectable record that this attempt happened —
   * which is the whole reason the rows are written before the provider is
   * called.
   *
   * IT NEVER THROWS. It is called from a `catch`, and a release that failed
   * loudly would replace the real reason for the failure with its own — the
   * buyer would be wedged AND nobody would know what wedged them. The original
   * error is rethrown by the caller either way; this only makes sure the
   * attempt is on the record.
   */
  private async releaseClaim(subscriptionId: string): Promise<void> {
    try {
      if ((await this.subscriptions.cancel(subscriptionId)) !== null) return;
      // `null` — either the row is gone, or it is already TERMINAL because
      // something else ended it first. Either way the pending slot is free and
      // there is nothing to warn about. One extra read, and only on a path that
      // has already failed.
      const row = await this.subscriptions.findById(subscriptionId);
      if (row !== null && row.status !== "pending") return;
    } catch {
      // Fall through to the same warning: "could not release" is the only fact
      // that matters here, and it is the same fact whether the statement
      // returned nothing or never returned at all.
    }
    // Ids only, never the payer's details. A claim that could not be
    // released is a buyer who cannot try again, so it must be visible.
    console.warn(
      `[payments] could not release the pending claim on user subscription ` +
        `${subscriptionId} after the checkout failed — this buyer cannot start ` +
        "another checkout with this creator until the row is cleared by hand"
    );
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
