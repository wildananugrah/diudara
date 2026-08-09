import {
  ProviderCallError,
  UnsupportedOperationError,
  type ProviderCallOutcome,
} from "../../application/errors";
import type {
  GrantAccessInput,
  MessagingCapabilities,
  MessagingProviderPort,
  NotifyInput,
  RevokeAccessInput,
  RevokeInviteLinkInput,
} from "../../application/ports/messaging-provider.port";

/** In-memory messaging provider for tests and local development. */
export class FakeMessagingAdapter implements MessagingProviderPort {
  readonly platform: string;
  readonly grants: GrantAccessInput[] = [];
  /**
   * Every link this adapter has handed out, in order. Tests assert on it to prove
   * that a retried grant issues NO second link: an invite link is a bearer
   * credential, so "one membership" is only half the property — the count of
   * links minted is the other half.
   */
  readonly issuedLinks: string[] = [];
  /**
   * Links this adapter was asked to REVOKE, in order. Together with `issuedLinks`
   * it makes `liveInviteLinks` below computable, and that getter is the only honest
   * way to test the credential-lifecycle invariant.
   */
  readonly revokedInviteLinks: RevokeInviteLinkInput[] = [];
  readonly revocations: RevokeAccessInput[] = [];
  readonly notifications: NotifyInput[] = [];
  /**
   * How the next `grantAccess` fails, and — crucially — WHETHER A RESPONSE WAS
   * RECEIVED. `false` means it succeeds.
   *
   * A plain boolean would not do, because the two failures have opposite consequences
   * for the mint window and therefore for whether a paying member can ever be granted
   * access again:
   *
   *   "rejected"      the provider answered "no" (a Telegram 429/5xx, an `ok: false`).
   *                   Nothing was minted, so `GrantChannelAccess` releases the mint
   *                   window and the next attempt mints normally.
   *   "indeterminate" the request never completed (a timeout, an abort). A link may be
   *                   live at the provider with nobody holding its value, so the marker
   *                   stays set and the grant fails closed.
   *
   * `true` is accepted and means `"indeterminate"`: the fail-closed direction, so a
   * test that does not think about the distinction cannot accidentally assert the
   * permissive behaviour.
   */
  failNextGrant: boolean | ProviderCallOutcome = false;
  failNextRevoke = false;
  /**
   * Makes `revokeInviteLink` fail once, so a test can cover the case where the
   * best-effort cleanup ITSELF fails — the one path that legitimately leaves a live
   * orphan, and which must therefore leave the mint marker set so no replacement is
   * ever minted on top of it.
   */
  failNextInviteLinkRevoke = false;

  private readonly canGate: boolean;
  private counter = 0;
  /**
   * Makes this instance's links distinct from every other instance's.
   *
   * Real invite links are globally unique, and
   * `channel_membership_invite_link_unique` now holds the database to that. Without
   * this suffix two adapters constructed in one test both issue
   * `https://fake-invite.local/telegram/1`, and the second grant fails on a
   * constraint that has nothing to do with what the test is checking.
   */
  private readonly instanceId = Math.random().toString(36).slice(2, 10);

  constructor(config: { platform: string; canGateAccess: boolean }) {
    this.platform = config.platform;
    this.canGate = config.canGateAccess;
  }

  capabilities(): MessagingCapabilities {
    return { canGateAccess: this.canGate };
  }

  private assertCanGate(operation: string): void {
    if (!this.canGate) {
      throw new UnsupportedOperationError(
        `${this.platform} cannot ${operation}: this provider does not support access gating`
      );
    }
  }

  async grantAccess(input: GrantAccessInput): Promise<{ inviteLink: string }> {
    this.assertCanGate("grant access");
    if (this.failNextGrant !== false) {
      const outcome: ProviderCallOutcome =
        this.failNextGrant === true ? "indeterminate" : this.failNextGrant;
      this.failNextGrant = false;
      throw new ProviderCallError(
        `fake messaging provider: grantAccess failed (${outcome})`,
        outcome
      );
    }
    this.grants.push(input);
    this.counter += 1;
    const inviteLink =
      `https://fake-invite.local/${this.platform}/${this.instanceId}-${this.counter}`;
    this.issuedLinks.push(inviteLink);
    return { inviteLink };
  }

  /** The most recent link, or `undefined` if nothing has been granted. */
  get lastInviteLink(): string | undefined {
    return this.issuedLinks[this.issuedLinks.length - 1];
  }

  /**
   * Links that have been minted and NOT revoked — i.e. credentials that would still
   * admit somebody if they were forwarded.
   *
   * THIS, not `channelMemberships.length` and not `issuedLinks.length`, is what a
   * test of grant idempotency has to assert on. The whole-branch review found four
   * live links behind one membership row with `invite_link = NULL`: every database
   * assertion passed, because the database was never the thing at risk. The invariant
   * is about the PROVIDER's state — at most one live link per (member, channel) — so
   * the count has to come from the provider's side of the boundary.
   */
  get liveInviteLinks(): string[] {
    const revoked = new Set(this.revokedInviteLinks.map((entry) => entry.inviteLink));
    return this.issuedLinks.filter((link) => !revoked.has(link));
  }

  async revokeInviteLink(input: RevokeInviteLinkInput): Promise<void> {
    this.assertCanGate("revoke an invite link");
    if (this.failNextInviteLinkRevoke) {
      this.failNextInviteLinkRevoke = false;
      throw new Error("fake messaging provider: revokeInviteLink failed");
    }
    this.revokedInviteLinks.push(input);
  }

  async revokeAccess(input: RevokeAccessInput): Promise<void> {
    this.assertCanGate("revoke access");
    if (this.failNextRevoke) {
      this.failNextRevoke = false;
      throw new Error("fake messaging provider: revokeAccess failed");
    }
    this.revocations.push(input);
  }

  async notify(input: NotifyInput): Promise<void> {
    this.notifications.push(input);
  }
}
