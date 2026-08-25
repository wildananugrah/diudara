import { NotFoundError } from "../errors";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";

/**
 * One pending free-membership request on the wire — the same fields
 * `PendingRequestRow` carries on the port, with `createdAt` ISO-stamped
 * (JSON has no date type, mirrors `ListSubscribers`'s `SubscriberListEntry`).
 */
export interface MembershipRequestEntry {
  id: string;
  subscriberHandle: string;
  subscriberDisplayName: string;
  tierName: string;
  createdAt: string;
}

/**
 * Task 5 of "free memberships" — `GET /users/me/membership-requests`,
 * `POST /users/me/membership-requests/:id/approve` and `/reject`. An owner's
 * queue of free-membership requests: what Task 4's `StartUserSubscription`
 * free path writes via `claimPending({ ..., kind: "free" })`, waiting on a
 * decision only the owner can make (spec §2.4 — a free tier is invitation-only
 * in the sense that the owner admits each request one at a time, never
 * self-service the way a paid purchase is).
 *
 * **THE TWO SHAPES ON PURPOSE.** The repository takes positional ids
 * (`approveFreeRequest(id, ownerId)`) — the existing convention every other
 * method on `UserSubscriptionRepositoryPort` follows. This class takes a
 * named object (`approve({ ownerId, requestId })`) — the existing convention
 * `StartUserSubscription.execute` and the other route-facing use-cases in
 * this codebase follow. Neither layer is copying the other's shape; each
 * matches what already surrounds it.
 *
 * **APPROVING NEVER READS THEN WRITES.** `approve` does not fetch the row
 * first to check it belongs to this owner and is still pending — that would
 * be exactly the read-then-write race this whole phase has repeatedly found
 * broken under concurrency (see `claimPending`'s and `retireExpired`'s own
 * docstrings). The repository's conditional UPDATE is the sole arbiter; this
 * class only turns its `null` into `NotFoundError`.
 *
 * **ONE ANSWER FOR "MISSING" AND "NOT YOURS".** `approveFreeRequest` and
 * `rejectRequest` both fold "no such id", "belongs to a different owner" and
 * "already decided" into the same `null`/`false` — this class throws the
 * identical `NotFoundError` for all of them, so an owner probing request ids
 * that are not theirs learns nothing a genuinely absent id would not also
 * tell them. Mirrors the media routes' "gated and absent look identical from
 * outside".
 *
 * **A CONSTRAINT VIOLATION IS ALREADY A `ConflictError` BY THE TIME IT
 * REACHES HERE.** `approveFreeRequest` translates `user_subscription_one_active`
 * at the repository boundary (see its own docstring) — this class does not
 * catch anything itself, it simply does not swallow what the repository
 * raises.
 */
export class MembershipRequests {
  constructor(private readonly subscriptions: UserSubscriptionRepositoryPort) {}

  async list(ownerId: string): Promise<{ requests: MembershipRequestEntry[] }> {
    const rows = await this.subscriptions.listPendingRequests(ownerId);
    return {
      requests: rows.map((row) => ({
        id: row.id,
        subscriberHandle: row.subscriberHandle,
        subscriberDisplayName: row.subscriberDisplayName,
        tierName: row.tierName,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async approve(input: { ownerId: string; requestId: string }): Promise<UserSubscriptionRow> {
    const row = await this.subscriptions.approveFreeRequest(input.requestId, input.ownerId);
    if (!row) {
      throw new NotFoundError("permintaan keanggotaan tidak ditemukan");
    }
    return row;
  }

  async reject(input: { ownerId: string; requestId: string }): Promise<void> {
    const rejected = await this.subscriptions.rejectRequest(input.requestId, input.ownerId);
    if (!rejected) {
      throw new NotFoundError("permintaan keanggotaan tidak ditemukan");
    }
  }
}
