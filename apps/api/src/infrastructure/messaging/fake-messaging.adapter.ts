import { UnsupportedOperationError } from "../../application/errors";
import type {
  GrantAccessInput,
  MessagingCapabilities,
  MessagingProviderPort,
  NotifyInput,
  RevokeAccessInput,
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
  readonly revocations: RevokeAccessInput[] = [];
  readonly notifications: NotifyInput[] = [];
  failNextGrant = false;
  failNextRevoke = false;

  private readonly canGate: boolean;
  private counter = 0;

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
    if (this.failNextGrant) {
      this.failNextGrant = false;
      throw new Error("fake messaging provider: grantAccess failed");
    }
    this.grants.push(input);
    this.counter += 1;
    const inviteLink = `https://fake-invite.local/${this.platform}/${this.counter}`;
    this.issuedLinks.push(inviteLink);
    return { inviteLink };
  }

  /** The most recent link, or `undefined` if nothing has been granted. */
  get lastInviteLink(): string | undefined {
    return this.issuedLinks[this.issuedLinks.length - 1];
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
