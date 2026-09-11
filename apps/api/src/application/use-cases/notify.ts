import type { NotificationRepositoryPort } from "../ports/notification-repository.port";

/**
 * The three things this product tells you about. Narrow ON PURPOSE: every
 * additional kind is a new way to be noisy, and a bell nobody trusts is a
 * bell nobody opens.
 *
 * New content in a community — a post, an event, a document — is deliberately
 * absent: it would fire for every member of every community on every write,
 * which is the shape of a notification system people mute.
 */
export const NOTIFICATION_KIND = {
  comment: "comment",
  join: "join",
  follow: "follow",
} as const;

export type NotificationKind = (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

/**
 * **The ONE place a notification is written, and the one place the two rules
 * that matter are implemented.**
 *
 * **It never throws.** This runs after the action it reports has already
 * committed. A rejection is logged and swallowed, because the alternative —
 * letting it propagate — means a bug here makes COMMENTING fail. Losing a
 * notification is undetectable by the person who missed it; losing a comment
 * is data loss the author watched happen.
 *
 * That is an accepted cost, stated plainly: **a notification can be lost.**
 * Nothing in the product may depend on one having arrived. The bell is a
 * convenience over state already readable elsewhere — the post has its
 * comments, the community has its members — never the only route to
 * something.
 *
 * **It never notifies you of your own action.** Checked HERE against
 * `actorId`, once, rather than in each call site having to remember.
 */
export class NotifyOf {
  constructor(
    private readonly notifications: NotificationRepositoryPort,
    /** Injected so a test can assert a failure was REPORTED, not merely swallowed. */
    private readonly logError: (line: string) => void = (line) => console.error(line)
  ) {}

  async record(input: {
    /** The recipient. */
    userId: string;
    kind: NotificationKind;
    actorId: string;
    postId?: string;
    communityId?: string;
  }): Promise<void> {
    // Commenting on your own post, joining your own community: no-ops, and
    // silently so — there is nothing to report.
    //
    // A `subscribe` kind was specified and dropped: activation happens inside
    // `HandlePaymentWebhook`'s transaction, and notifying after the commit
    // would mean editing the payment webhook — which Phase 5's spec names as
    // a stop signal. It joins 8b.
    if (input.userId === input.actorId) return;

    try {
      await this.notifications.create(input);
    } catch (error: unknown) {
      // LOGGED, never rethrown. A silent swallow would make a broken
      // notification path invisible until somebody noticed the bell had gone
      // quiet, which could be weeks.
      this.logError(
        `[notify] failed to record a ${input.kind} notification for user=${input.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
