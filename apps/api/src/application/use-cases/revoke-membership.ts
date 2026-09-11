import { ConflictError, NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";

/**
 * An owner removes one of their own members.
 *
 * BY HANDLE, NOT BY SUBSCRIPTION ID. `listActiveSubscribers`' projection is
 * deliberately narrow — handle, display name, since, and now kind — and its
 * docstring records that the excluded columns are never fetched at all, not
 * merely stripped afterwards. Widening it to emit a subscription id so the
 * client could name one back would undo that on purpose. The handle is
 * already on screen; the server resolves the rest.
 *
 * FREE MEMBERSHIPS ONLY, and this is a product decision rather than a
 * technical limit. Cancelling a PAID membership mid-period stops a service
 * the member has already paid for, and there is no refund path anywhere in
 * this product — a whole-branch review noted that in passing when it found a
 * race that can already reach "charged, and no membership". Until money can
 * travel back, an owner may not take it and cut the service. The refusal says
 * so rather than pretending the member does not exist.
 *
 * `cancel()` does the work and already carries the rules that matter: it
 * touches only a LIVE row, leaves a terminal one exactly as it is, and frees
 * the `user_subscription_one_active` slot so the same person can join again
 * later. Revocation is not a ban.
 */
export class RevokeMembership {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort
  ) {}

  async execute(input: { ownerId: string; handle: string }): Promise<{ ok: true }> {
    const member = await this.users.findByHandle(normalizeHandle(input.handle));
    // The SAME answer for "no such person" and "not a member of yours", so an
    // owner cannot use this route to learn which handles exist — the rule the
    // media routes and the membership-request queue already follow.
    if (!member) throw new NotFoundError("anggota tidak ditemukan");

    const active = await this.subscriptions.findActiveFor(member.id, input.ownerId, null /* personal membership — see the port's note on this argument */);
    if (!active) throw new NotFoundError("anggota tidak ditemukan");

    if (active.kind !== "free") {
      throw new ConflictError(
        "Keanggotaan berbayar tidak dapat dihentikan dari sini — pembayaran untuk periode ini sudah diterima."
      );
    }

    // `cancel` returns null when the row was already terminal — somebody else
    // ended it between the read above and this write. Nothing to do, and the
    // caller's intent is satisfied either way: that person is not a member.
    await this.subscriptions.cancel(active.id);
    return { ok: true };
  }
}
