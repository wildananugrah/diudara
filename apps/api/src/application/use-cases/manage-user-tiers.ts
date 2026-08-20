import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { isConnectedPaymentAccount } from "../../domain/payment-account";
import type { UserTierRepositoryPort, UserTierRow } from "../ports/user-tier-repository.port";
import type { UserPayoutRepositoryPort } from "../ports/user-payout-repository.port";

/**
 * The only billing cycle Phase 5a sells. `user_tier.billing_cycle` is a
 * varchar rather than an enum specifically so 5b can widen this set without a
 * migration (spec §4) — but until 5b does, this use case is the one place
 * that enforces the set is exactly this, so a client cannot write `"yearly"`
 * into a column nothing downstream (renewals, the profile offer) knows how to
 * honour yet.
 */
const ALLOWED_BILLING_CYCLES: ReadonlySet<string> = new Set(["monthly"]);
const DEFAULT_BILLING_CYCLE = "monthly";

/**
 * `POST /users/me/tiers`, `GET /users/me/tiers`, `PATCH /users/me/tiers/:tierId`
 * — a creator defining what they sell on their own profile (spec §5-§6).
 *
 * Three methods on one class, not three classes, because unlike the dashboard's
 * `DefineMembershipTier`/`ListTiers`/`UpdateTier` (`manage-tiers.ts`) none of
 * these needs a distinct constructor: every one of them touches the same two
 * ports (`tiers`, `payouts`) and there is no community to look up first. That
 * file is a DIFFERENT table (`membership_tier`) behind `/dashboard/*` and is
 * untouched by this one.
 */
export class ManageUserTiers {
  constructor(
    private readonly tiers: UserTierRepositoryPort,
    private readonly payouts: UserPayoutRepositoryPort
  ) {}

  /**
   * THE GATE THIS TASK EXISTS FOR: a tier cannot be published without a
   * *connected* payout account — a membership whose money has nowhere to go
   * is a trap for buyer and seller both (spec §5).
   *
   * Read through `isConnectedPaymentAccount`, never a truthiness check.
   * `xendit_account_id` has three states — NULL, the
   * `XENDIT_ACCOUNT_PROVISIONING` sentinel, and a real account id — and the
   * sentinel is truthy. A truthiness check here would let a half-provisioned,
   * KYC-pending connection publish a tier that Task 6 would then send to
   * Xendit as `for_account_id: "provisioning:in-progress"` when somebody
   * tried to buy it. `StartCheckout` and `ConnectUserPayout` both make the
   * identical mistake impossible for the same reason; this is the same
   * predicate, not a re-derivation of it.
   */
  async create(input: {
    ownerId: string;
    name: string;
    priceAmount: number;
    billingCycle?: string;
  }): Promise<UserTierRow> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ValidationError("Nama tingkatan tidak boleh kosong.");
    }
    // Strictly positive, not merely non-negative — a free tier is not a
    // membership anyone needs to pay to hold, and `0` would sail through the
    // dashboard's own `assertValidTier` (which only rejects negative prices)
    // if this use case borrowed it. It deliberately does not.
    if (!Number.isInteger(input.priceAmount) || input.priceAmount <= 0) {
      throw new ValidationError("Harga tingkatan harus lebih dari nol.");
    }
    const billingCycle = input.billingCycle ?? DEFAULT_BILLING_CYCLE;
    if (!ALLOWED_BILLING_CYCLES.has(billingCycle)) {
      throw new ValidationError("Siklus tagihan yang didukung saat ini hanya bulanan.");
    }

    const payout = await this.payouts.findPayoutAccount(input.ownerId);
    if (!payout) {
      // Cannot happen for a caller who just authenticated as this user — kept
      // as a defensive NotFoundError, English like every other NotFoundError
      // call site in this codebase, rather than assumed away.
      throw new NotFoundError("user not found");
    }
    if (!isConnectedPaymentAccount(payout.xenditAccountId)) {
      throw new ConflictError(
        "Hubungkan akun pembayaran Anda terlebih dahulu sebelum menerbitkan tingkatan " +
          "keanggotaan — uang dari tingkatan ini belum punya tempat tujuan."
      );
    }

    return this.tiers.create({
      ownerId: input.ownerId,
      name,
      priceAmount: input.priceAmount,
      billingCycle,
    });
  }

  /**
   * Every tier this owner has EVER defined, active and deactivated alike —
   * this is the owner's own management view (Pengaturan's tier editor), not
   * the public offer. `UserTierRepositoryPort.listActiveByOwner` is what
   * Task 5's profile route reads instead; this method never calls it.
   */
  async list(ownerId: string): Promise<UserTierRow[]> {
    return this.tiers.listByOwner(ownerId);
  }

  /**
   * Withdraws a tier from sale. Never deletes the row and never touches
   * `user_subscription` — an existing member's subscription keeps resolving
   * through the tier's `id` exactly as it did before (spec §4's
   * `UserTierRepositoryPort.deactivate` doc comment), because nothing here
   * calls anything on the subscription port at all.
   *
   * 404s, not 403s, when `tierId` belongs to someone else — same choice
   * `manage-tiers.ts`'s `assertOwnsCommunity` makes for a community, so a
   * caller probing another owner's tier ids learns nothing they could not
   * already see (a public tier is listed on the profile; a private one
   * behaves as if it does not exist).
   */
  async deactivate(input: { ownerId: string; tierId: string }): Promise<UserTierRow> {
    const tier = await this.tiers.findById(input.tierId);
    if (!tier || tier.ownerId !== input.ownerId) {
      throw new NotFoundError("tier not found");
    }
    const updated = await this.tiers.deactivate(input.tierId);
    if (!updated) {
      // Unreachable in practice — the row was just read above — but a
      // deleted-between-read-and-write race is not this method's to assume
      // away silently.
      throw new NotFoundError("tier not found");
    }
    return updated;
  }
}
