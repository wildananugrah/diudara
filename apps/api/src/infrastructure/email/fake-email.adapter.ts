import type { EmailProviderPort, SendEmailInput } from "../../application/ports/email-provider.port";

/**
 * In-memory email provider for tests and local development.
 *
 * Records every send so a test can assert WHAT was sent and to WHOM without a
 * network — mirrors `FakePaymentAdapter`/`FakeMessagingAdapter`. Never used
 * outside `RELAXED_NODE_ENVS` (`development`/`test`) — see
 * `selectEmailProvider` in `bootstrap.ts` for the guard that keeps it out of
 * anywhere else, and why the disabled case returns `null` rather than falling
 * back to this class.
 */
export class FakeEmailAdapter implements EmailProviderPort {
  readonly sent: SendEmailInput[] = [];

  async send(input: SendEmailInput): Promise<void> {
    this.sent.push(input);
  }
}
