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
  readonly revocations: RevokeAccessInput[] = [];
  readonly notifications: NotifyInput[] = [];
  failNextGrant = false;

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
    return { inviteLink: `https://fake-invite.local/${this.platform}/${this.counter}` };
  }

  async revokeAccess(input: RevokeAccessInput): Promise<void> {
    this.assertCanGate("revoke access");
    this.revocations.push(input);
  }

  async notify(input: NotifyInput): Promise<void> {
    this.notifications.push(input);
  }
}
