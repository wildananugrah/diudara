import { NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";

/**
 * A member ends their OWN membership.
 *
 * ANY membership — free, paid and inside its period, or paid and lapsed —
 * unlike `RevokeMembership`, which an owner may use on free ones only. The
 * asymmetry is the point: a member spending their own access is making a
 * choice about their own money, while an owner cutting a paid member off
 * would be taking it from them, and this product has no refund path.
 *
 * THIS IS ALSO THE FIX FOR SPEC §9's TRAP, which is why it matters more than
 * a convenience. `StartUserSubscription`'s refusal is deliberately
 * STATUS-ONLY, and must stay so: a lapsed row let past it collides with
 * `user_subscription_one_active` at activation time, turning a broken button
 * into *charged and not activated*. The consequence — named in the spec and
 * accepted at the time — is that a former paying member whose row sits
 * `active` with a `current_period_end` long past is refused EVERYTHING: a new
 * purchase and a free request alike. There is no renewal pass in this
 * product, so every paying member reaches that state eventually and stays
 * there for ever. §9 says the fix is "a way to retire a lapsed row, which is
 * the cancellation/revocation work §8 defers". This is that way.
 *
 * `cancel()` carries the rules that matter: it touches only a LIVE row
 * (`pending` or `active`), leaves a terminal one exactly as it is, and frees
 * the `user_subscription_one_active` slot — so leaving is not a ban either,
 * and the same person can join that creator again afterwards.
 */
export class LeaveMembership {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort
  ) {}

  async execute(input: { subscriberId: string; ownerHandle: string }): Promise<{ ok: true }> {
    const owner = await this.users.findByHandle(normalizeHandle(input.ownerHandle));
    // The SAME answer for "no such creator" and "you are not a member of
    // theirs" — the rule the media routes, the request queue and revocation
    // already follow, so this route cannot be used to probe which handles
    // exist.
    if (!owner) throw new NotFoundError("keanggotaan tidak ditemukan");

    const active = await this.subscriptions.findActiveFor(input.subscriberId, owner.id, null /* personal membership — see the port's note on this argument */);
    if (!active) throw new NotFoundError("keanggotaan tidak ditemukan");

    // No `kind` check, deliberately — see this class's docstring. A member may
    // end any membership of their own, including one still inside a paid
    // period; the screen is what tells them what that costs.
    await this.subscriptions.cancel(active.id);
    return { ok: true };
  }
}
