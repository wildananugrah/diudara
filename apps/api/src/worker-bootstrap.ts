import { db } from "./db/client";
import {
  assertUsableStreamingSecret,
  resolveAppBaseUrl,
  selectEmailProvider,
  selectMessagingProviders,
  type MessagingProviders,
} from "./bootstrap";
import type { ClockPort } from "./application/ports/clock.port";
import type { EmailProviderPort } from "./application/ports/email-provider.port";
import { RemindExpiringMembership } from "./application/use-cases/remind-expiring-membership";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { DrizzleActivityLogRepository } from "./infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleChannelMembershipRepository } from "./infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleChannelRepository } from "./infrastructure/repositories/drizzle-channel.repository";
import { DrizzleEventRepository } from "./infrastructure/repositories/drizzle-event.repository";
import { DrizzleJoinRequestRepository } from "./infrastructure/repositories/drizzle-join-request.repository";
import { DrizzleMemberRepository } from "./infrastructure/repositories/drizzle-member.repository";
import { DrizzleMembershipReminderRepository } from "./infrastructure/repositories/drizzle-membership-reminder.repository";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleRenewalReminderRepository } from "./infrastructure/repositories/drizzle-renewal-reminder.repository";
import { DrizzleSubscriptionRepository } from "./infrastructure/repositories/drizzle-subscription.repository";
import { DrizzleUserRepository } from "./infrastructure/repositories/drizzle-user.repository";
import { DrizzleUserSubscriptionRepository } from "./infrastructure/repositories/drizzle-user-subscription.repository";
import { ProcessChurn } from "./application/use-cases/process-churn";
import { ProcessRenewals } from "./application/use-cases/process-renewals";
import {
  GrantChannelAccess,
  grantAccessOutboxHandler,
} from "./application/use-cases/grant-channel-access";
import {
  RetryChannelAccessRevocation,
  RevokeChannelAccessForSystem,
  revokeAccessOutboxHandler,
  revokeSubscriptionAccessOutboxHandler,
} from "./application/use-cases/revoke-channel-access";
import {
  SendRenewalReminder,
  sendRenewalReminderOutboxHandler,
} from "./application/use-cases/send-renewal-reminder";
import {
  NotifyStreamLive,
  notifyStreamLiveOutboxHandler,
} from "./application/use-cases/notify-stream-live";
import {
  NotifyJoinRequest,
  notifyJoinRequestOutboxHandler,
} from "./application/use-cases/notify-join-request";
import { ProcessOutbox, type OutboxHandler } from "./application/use-cases/process-outbox";
import {
  OUTBOX_GRANT_ACCESS,
  OUTBOX_NOTIFY_JOIN_REQUEST,
  OUTBOX_NOTIFY_STREAM_LIVE,
  OUTBOX_REVOKE_ACCESS,
  OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
  OUTBOX_SEND_RENEWAL_REMINDER,
} from "./application/ports/outbox-repository.port";

/**
 * What `apps/worker` needs to do its job. `messaging` is exposed so a test can
 * prove which adapters a given environment selected — the API's `Dependencies`
 * exposes `payments` for the same reason.
 */
export interface WorkerDependencies {
  processOutbox: ProcessOutbox;
  /**
   * Phase 5's two SCHEDULED passes — the reason this process now has a cadence and not
   * just a queue.
   *
   * Everything else here is a handler: something reacts to a row somebody else wrote.
   * These two are the only things in the codebase that act because time has passed, and
   * until Task 7 nothing constructed them at all. `apps/worker/src/main.ts` runs each on
   * its own `PollLoop`.
   */
  processRenewals: ProcessRenewals;
  processChurn: ProcessChurn;
  /**
   * The ONE clock both passes read, exposed so a test can prove this root injected the
   * real one. `FixedClock` lives in the same workspace, and a root that wired it by
   * accident would leave every member's reminder stage frozen on the day the worker
   * booted — silently, and for a whole billing cycle.
   */
  clock: ClockPort;
  grantChannelAccess: GrantChannelAccess;
  /**
   * Exposed for the same reason as `grantChannelAccess`: a test must be able to prove
   * the worker can actually complete a removal the API failed to make, rather than
   * only that a handler is registered under the right string.
   */
  retryChannelAccessRevocation: RetryChannelAccessRevocation;
  /**
   * Phase 5's reminder delivery. Exposed for the same reason as the two above, and for
   * one more: its message carries a checkout link built from `APP_BASE_URL`, and this is
   * the process that sends it — so a test has to be able to prove the value reached
   * THIS root and not only the API's. Phase 3 shipped a confirmation page that was
   * unreachable for a whole phase because nothing checked that wiring.
   */
  sendRenewalReminder: SendRenewalReminder;
  /**
   * Phase 5's system-initiated revoke — the other end of the churn pass.
   *
   * Exposed for the same reason as the three above, and for one specific to it: it is
   * the ONE use-case in the codebase with no authorization check, so a test has to be
   * able to prove that the thing wired against `revoke_subscription_access` is this
   * class and not the creator-facing one with an invented creator id (spec §5).
   */
  revokeChannelAccessForSystem: RevokeChannelAccessForSystem;
  /**
   * Task 5's `notify_stream_live` consumer — `undefined` exactly when
   * `STREAM_TOKEN_SECRET` is unset, mirroring `Dependencies.authoriseStream`'s
   * own undefined-ness in the API root: without it there is no secret to sign
   * a watch token with, and a row can only exist at all if the API's own
   * `handleStreamLifecycle` was configured to enqueue one, which needs the
   * same secret. Exposed for the same reason as `grantChannelAccess`: a test
   * must be able to prove the worker can actually notify a member, not only
   * that a handler is registered under the right string.
   */
  notifyStreamLive: NotifyStreamLive | undefined;
  /**
   * Task 5's `notify_join_request` consumer — the free-community counterpart to
   * `NotifyStreamLive`. Unlike that field, this is never `undefined`: it depends
   * only on `messaging.notifier`, which `selectMessagingProviders` guarantees
   * whenever `bootstrapWorker()` returns at all (no separate secret gates it the
   * way `STREAM_TOKEN_SECRET` gates streaming). Exposed for the same reason as
   * `grantChannelAccess`: a test must be able to prove the worker can actually
   * notify an owner, not only that a handler is registered under the right string.
   */
  notifyJoinRequest: NotifyJoinRequest;
  /**
   * Task 4 of Phase 5b's SCHEDULED pass — the one that tells a member their membership
   * is about to end.
   *
   * Exposed for the same reason as `processRenewals`, and for one specific to it:
   * there is no recurring charge anywhere in this system, so nothing renews and this
   * pass is the ONLY thing that tells a member to buy again. A root that failed to
   * construct it would leave every membership ending in silence, and nothing else in
   * the process would notice.
   */
  remindExpiringMemberships: RemindExpiringMembership;
  /**
   * The email adapter this root selected, or `null` when email is DISABLED on this box
   * (see `selectEmailProvider`). Exposed for the same reason `messaging` is: a test
   * has to be able to prove which adapters an environment actually chose — and here
   * the `null` case is a behaviour, not an absence, because it is half of what makes
   * `RemindExpiringMembership` record a skip instead of reaching nobody in silence.
   */
  email: EmailProviderPort | null;
  messaging: MessagingProviders;
}

/**
 * The WORKER's composition root, deliberately separate from `bootstrap()`.
 *
 * The worker serves no HTTP request, so it has no session tokens to sign and no
 * invoices to create — and making it refuse to start without `JWT_SECRET` or the
 * Xendit keys would be a deployment hazard, not a safety guard. What it DOES need is
 * the messaging configuration, which is selected through the same allowlist
 * (`selectMessagingProviders`): a worker running the fake adapters looks exactly
 * like a working one while every paying member waits for a message that never
 * arrives.
 *
 * IT ALSO NEEDS `APP_BASE_URL` NOW, which it did not before Phase 5. This comment used
 * to say the worker had "no confirmation page to link to"; that stopped being true when
 * renewal reminders started carrying a checkout link to `/c/:slug`, built from the same
 * origin Phase 3 uses for `success_redirect_url`. It is resolved through the SAME
 * `resolveAppBaseUrl` the API calls, deliberately — including its guard, so a
 * production worker with the variable unset refuses to boot instead of sending every
 * member a link to `localhost:5173` on their own phone. That is the loud failure; the
 * quiet one is worse.
 *
 * The outbox is read with the POOLED client. Nothing here opens a transaction:
 * sends are external HTTP calls, and one must never be able to roll back a
 * payment (plan, Global Constraints).
 */
export function bootstrapWorker(): WorkerDependencies {
  const messaging = selectMessagingProviders({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    fonnteApiToken: process.env.FONNTE_API_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });

  const grantChannelAccess = new GrantChannelAccess(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleChannelRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    messaging.gating,
    // The WhatsApp provider, never the gating one: TelegramBotAdapter.notify
    // throws, because it addresses a WhatsApp number it has no way to reach.
    messaging.notifier
  );

  // The other direction, and the half that had no retry at all: a platform removal
  // the API could not perform. `RevokeChannelAccess` enqueues one of these instead of
  // dropping it, so a churned member does not stay in the paid group forever with no
  // record that a removal is owed — which is what Phase 5's churn job would otherwise
  // inherit. Same bounded retries as every other event type.
  const retryChannelAccessRevocation = new RetryChannelAccessRevocation(
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    messaging.gating
  );

  // Phase 5's reminder delivery. The base URL comes from the same resolver the API
  // uses, so the link in a reminder and the `success_redirect_url` in an invoice can
  // never disagree about which deployment they belong to.
  const sendRenewalReminder = new SendRenewalReminder(
    new DrizzleSubscriptionRepository(db),
    new DrizzleMemberRepository(db),
    new DrizzleActivityLogRepository(db),
    // The WhatsApp provider, never the gating one — `TelegramBotAdapter.notify` throws,
    // so a reminder routed there would leave the member unwarned before revocation.
    messaging.notifier,
    {
      appBaseUrl: resolveAppBaseUrl({
        appBaseUrl: process.env.APP_BASE_URL,
        nodeEnv: process.env.NODE_ENV,
      }),
    }
  );

  // Phase 5's churn revoke. NO creator repository is passed, because it performs no
  // creator scoping — see the class docstring for why resolving a creator id from the
  // subscription and calling `RevokeChannelAccess` instead would be authorization
  // theatre. The composition root is where that would have been done, so this is where
  // saying it matters.
  const revokeChannelAccessForSystem = new RevokeChannelAccessForSystem(
    new DrizzleSubscriptionRepository(db),
    new DrizzleChannelMembershipRepository(db),
    new DrizzleActivityLogRepository(db),
    messaging.gating,
    // A removal the provider refuses becomes a `revoke_access` row here, exactly as it
    // does on the creator-facing path: the shared revoker owns that, so churn inherits
    // the bounded retry rather than growing its own.
    new DrizzleOutboxRepository(db)
  );

  // ONE clock for the process, exactly as `bootstrap()` keeps one for the API. Two
  // clocks would be two answers to "what WIB day is it" inside the same worker, and the
  // renewal pass writes the grace deadline the churn pass then measures against.
  const clock = new SystemClock();

  // Phase 5's SCHEDULED passes. Nothing constructed these before Task 7: their outbox
  // handlers were registered above and their use-cases were tested, but no process ever
  // called `execute()` — the reminders and the churn were reachable only from a test.
  // This is the line that makes the phase run.
  //
  // Each takes the pooled `db`, like every other reader here: neither opens a
  // transaction, because both deliberately do their writing one row at a time so a
  // failure on the hundredth member cannot undo the ninety-nine reminders already
  // claimed.
  const processRenewals = new ProcessRenewals(
    new DrizzleSubscriptionRepository(db),
    new DrizzleRenewalReminderRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock
  );
  const processChurn = new ProcessChurn(
    new DrizzleSubscriptionRepository(db),
    new DrizzleOutboxRepository(db),
    new DrizzleActivityLogRepository(db),
    clock
  );

  // Task 5's `notify_stream_live` consumer. `STREAM_TOKEN_SECRET` is read directly
  // here, exactly the way `bootstrap()` reads it for `authoriseStream`, rather than
  // re-derived from anything else — see `WorkerDependencies.notifyStreamLive`'s own
  // docstring for why `undefined` here can only happen alongside the API root's own
  // `authoriseStream`/`handleStreamLifecycle` being `undefined` too.
  //
  // Run through `assertUsableStreamingSecret` — the SAME length floor
  // `selectStreamingProvider` enforces on the API side, not a bare presence check.
  // Without it, a worker box whose `STREAM_TOKEN_SECRET` diverges from (or is merely
  // shorter/weaker than) the API's own would happily mint watch tokens the API's
  // `AuthoriseStream` rejects at read time — every member gets a link that 403s on
  // every segment, and nothing here would ever fail to surface it.
  const streamTokenSecret =
    typeof process.env.STREAM_TOKEN_SECRET === "string" && process.env.STREAM_TOKEN_SECRET.length > 0
      ? process.env.STREAM_TOKEN_SECRET
      : undefined;
  if (streamTokenSecret) {
    assertUsableStreamingSecret("STREAM_TOKEN_SECRET", streamTokenSecret);
  }
  const notifyStreamLive = streamTokenSecret
    ? new NotifyStreamLive(
        new DrizzleEventRepository(db),
        new DrizzleSubscriptionRepository(db),
        new DrizzleMemberRepository(db),
        new DrizzleActivityLogRepository(db),
        // The WhatsApp provider, never the gating one — same rule as
        // `grantChannelAccess`/`sendRenewalReminder` above:
        // `TelegramBotAdapter.notify` throws.
        messaging.notifier,
        // The SAME clock instance every other pass in this root shares — see
        // `WorkerDependencies.clock`'s own docstring for why a second clock
        // constructed here would be a bug, not a style choice.
        clock,
        {
          appBaseUrl: resolveAppBaseUrl({
            appBaseUrl: process.env.APP_BASE_URL,
            nodeEnv: process.env.NODE_ENV,
          }),
          streamTokenSecret,
        }
      )
    : undefined;

  // Task 5's `notify_join_request` consumer: a member asked to join a free
  // community, and the owner gets told. No optional config gates it — it needs
  // only `messaging.notifier`, which is always present by the time
  // `bootstrapWorker()` returns (see `WorkerDependencies.notifyJoinRequest`'s own
  // docstring for why that differs from `notifyStreamLive` below) — so it is
  // constructed and registered unconditionally, the same as `grantChannelAccess`.
  const notifyJoinRequest = new NotifyJoinRequest(
    new DrizzleJoinRequestRepository(db),
    new DrizzleActivityLogRepository(db),
    // The WhatsApp provider, never the gating one — same rule as every other
    // notifier in this root: `TelegramBotAdapter.notify` throws.
    messaging.notifier
  );

  const handlers = new Map<string, OutboxHandler>([
    [OUTBOX_GRANT_ACCESS, grantAccessOutboxHandler(grantChannelAccess)],
    [OUTBOX_REVOKE_ACCESS, revokeAccessOutboxHandler(retryChannelAccessRevocation)],
    [OUTBOX_SEND_RENEWAL_REMINDER, sendRenewalReminderOutboxHandler(sendRenewalReminder)],
    [
      OUTBOX_REVOKE_SUBSCRIPTION_ACCESS,
      revokeSubscriptionAccessOutboxHandler(revokeChannelAccessForSystem),
    ],
    [OUTBOX_NOTIFY_JOIN_REQUEST, notifyJoinRequestOutboxHandler(notifyJoinRequest)],
  ]);
  // Registered ONLY when configured — an unregistered event type is not silent:
  // `ProcessOutbox` fails the row (bounded retry, then permanent), which is the
  // right outcome for a `notify_stream_live` row that should never have been
  // enqueued in the first place on a box with streaming disabled.
  if (notifyStreamLive) {
    handlers.set(OUTBOX_NOTIFY_STREAM_LIVE, notifyStreamLiveOutboxHandler(notifyStreamLive));
  }

  // Task 4 of Phase 5b: reminding a member BEFORE their membership ends. Selected
  // through the SAME allowlist the API root uses, and it may legitimately be `null` —
  // a box with no `RESEND_API_KEY`/`EMAIL_FROM` outside development has no email
  // channel at all. That is not a boot failure (see `selectEmailProvider`'s own
  // docstring for why it degrades instead of throwing), and the reminder pass is built
  // to see the absence and record the skip rather than reach nobody in silence.
  const email = selectEmailProvider({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
    nodeEnv: process.env.NODE_ENV,
  });

  const remindExpiringMemberships = new RemindExpiringMembership(
    new DrizzleUserSubscriptionRepository(db),
    new DrizzleUserRepository(db),
    new DrizzleMembershipReminderRepository(db),
    email,
    // The WhatsApp provider, never a gating one — the same rule every other notifier
    // in this root follows: `TelegramBotAdapter.notify` throws, because it addresses a
    // WhatsApp number it has no way to reach.
    messaging.notifier,
    // The SAME clock instance every other pass here shares — see
    // `WorkerDependencies.clock` for why a second clock constructed here would be a
    // bug and not a style choice. The window boundary this pass reads is a moment,
    // not a WIB day, but two clocks in one worker is still two answers to "now".
    clock,
    {
      appBaseUrl: resolveAppBaseUrl({
        appBaseUrl: process.env.APP_BASE_URL,
        nodeEnv: process.env.NODE_ENV,
      }),
    }
  );

  return {
    processOutbox: new ProcessOutbox(new DrizzleOutboxRepository(db), handlers),
    remindExpiringMemberships,
    email,
    processRenewals,
    processChurn,
    clock,
    grantChannelAccess,
    retryChannelAccessRevocation,
    sendRenewalReminder,
    revokeChannelAccessForSystem,
    notifyStreamLive,
    notifyJoinRequest,
    messaging,
  };
}
