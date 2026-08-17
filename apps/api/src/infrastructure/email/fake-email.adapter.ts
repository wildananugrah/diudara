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
 *
 * `echo` EXISTS BECAUSE `sent` IS UNREACHABLE FROM OUTSIDE THIS PROCESS, which
 * the Task 7 gate found: in a running `bun run dev` API the only holder of this
 * instance is `bootstrap()`, so a developer who requests a password reset
 * locally gets a cheerful `{ ok: true }` and NO WAY AT ALL to obtain the link
 * (33 links were minted against the dev database during that gate while the
 * API's stdout stayed at its six startup lines). Password reset therefore could
 * not be exercised end to end in local development — the one environment this
 * class exists to serve. `echo: true` prints the message so it can be, which is
 * the same remedy the PREVIOUS phase's gate applied to `FakeAiAdapter`'s
 * unreachable behaviours (`AI_FAKE_BEHAVIOUR`, see `resolveAiFakeBehaviour`).
 *
 * IT PRINTS THE WHOLE BODY, RESET LINK INCLUDED, AND THAT IS THE POINT. Every
 * other component in this feature refuses to log the token (see
 * `RequestPasswordReset.send`'s `console.warn`, which names only the channel and
 * the user id, and both real adapters' "no request/response body" rules) because
 * there the log is a place a secret can LEAK TO. Here the "recipient" and the
 * operator reading stdout are the same person, and nothing was ever sent
 * anywhere: the message exists only in this array. `echo` defaults to `false` so
 * the 100+ tests that construct this class directly stay silent, and
 * `selectEmailProvider` turns it on only for `NODE_ENV=development` — never for
 * `test` (that would bury genuine failure output, the same reason
 * `logProviderChoice` is silent there) and never anywhere else, since this class
 * is unreachable outside the relaxed environments to begin with.
 */
export class FakeEmailAdapter implements EmailProviderPort {
  readonly sent: SendEmailInput[] = [];
  private readonly echo: boolean;

  constructor(config: { echo?: boolean } = {}) {
    this.echo = config.echo ?? false;
  }

  async send(input: SendEmailInput): Promise<void> {
    this.sent.push(input);
    if (this.echo) {
      // ONE `console.log` call, not one per line: a test capturing output can
      // then assert on a single entry, and an operator's terminal keeps the
      // message together instead of interleaving it with request logging.
      console.log(
        `[fake-email] no email provider is configured, so nothing was sent. ` +
          `The message follows so you can use it locally.\n` +
          `  to:      ${input.to}\n` +
          `  subject: ${input.subject}\n` +
          `${input.body}`
      );
    }
  }
}
