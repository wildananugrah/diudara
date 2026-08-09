import { db, sql } from "./db/client";
import { DrizzleCreatorRepository } from "./infrastructure/repositories/drizzle-creator.repository";
import { DrizzleCommunityRepository } from "./infrastructure/repositories/drizzle-community.repository";
import { BunPasswordHasher } from "./infrastructure/auth/bun-password.hasher";
import { HonoJwtTokenIssuer } from "./infrastructure/auth/hono-jwt.token-issuer";
import { RegisterCreator } from "./application/use-cases/register-creator";
import { AuthenticateCreator } from "./application/use-cases/authenticate-creator";
import { CreateCommunity } from "./application/use-cases/create-community";
import { ListCommunities } from "./application/use-cases/list-communities";
import { UpdateCommunity } from "./application/use-cases/update-community";
import { DrizzleMembershipTierRepository } from "./infrastructure/repositories/drizzle-membership-tier.repository";
import {
  DefineMembershipTier,
  ListTiers,
  UpdateTier,
} from "./application/use-cases/manage-tiers";
import { DrizzleChannelRepository } from "./infrastructure/repositories/drizzle-channel.repository";
import { ConnectChannel, ListChannels } from "./application/use-cases/manage-channels";
import { CreatePaymentAccount } from "./application/use-cases/create-payment-account";
import { GetPublicCommunity } from "./application/use-cases/get-public-community";
import { StartCheckout } from "./application/use-cases/start-checkout";
import { GetSubscriptionStatus } from "./application/use-cases/get-subscription-status";
import { HandlePaymentWebhook } from "./application/use-cases/handle-payment-webhook";
import { RevokeChannelAccess } from "./application/use-cases/revoke-channel-access";
import { RecordChannelJoin } from "./application/use-cases/record-channel-join";
import { SendRenewalReminder } from "./application/use-cases/send-renewal-reminder";
import { FakePaymentAdapter } from "./infrastructure/payments/fake-payment.adapter";
import { XenditPaymentAdapter } from "./infrastructure/payments/xendit-payment.adapter";
import { DrizzleMemberRepository } from "./infrastructure/repositories/drizzle-member.repository";
import { DrizzleSubscriptionRepository } from "./infrastructure/repositories/drizzle-subscription.repository";
import { DrizzlePaymentActivationUnitOfWork } from "./infrastructure/repositories/drizzle-payment-activation.unit-of-work";
import { DrizzleChannelMembershipRepository } from "./infrastructure/repositories/drizzle-channel-membership.repository";
import { DrizzleActivityLogRepository } from "./infrastructure/repositories/drizzle-activity-log.repository";
import { DrizzleAnalyticsRepository } from "./infrastructure/repositories/drizzle-analytics.repository";
import { GetCommunityMetrics } from "./application/use-cases/get-community-metrics";
import { GetCommunityActivity } from "./application/use-cases/get-community-activity";
import { DrizzleOutboxRepository } from "./infrastructure/repositories/drizzle-outbox.repository";
import { SystemClock } from "./infrastructure/clock/system.clock";
import { FakeMessagingAdapter } from "./infrastructure/messaging/fake-messaging.adapter";
import { FonnteWhatsAppAdapter } from "./infrastructure/messaging/fonnte-whatsapp.adapter";
import { TelegramBotAdapter } from "./infrastructure/messaging/telegram-bot.adapter";
import type { MessagingProviderPort } from "./application/ports/messaging-provider.port";
import type { CreatorRepositoryPort } from "./application/ports/creator-repository.port";
import type { TokenIssuerPort } from "./application/ports/token-issuer.port";
import type { PaymentProviderPort } from "./application/ports/payment-provider.port";

/** Values that may be interpolated into a `DatabasePing` tagged template. */
type PingValue = string | number | boolean | Date | null;

/**
 * The narrowest slice of the SQL client the app is allowed to depend on: a
 * tagged-template liveness probe. The health route calls the database client
 * directly — a deliberate, owner-ruled exception to the ports rule (see the
 * plan's Global Constraints) — but injecting this instead of postgres.js's full
 * `Sql` denies routes `.unsafe()`, `.file()`, `.begin()` and connection control.
 *
 * The rest parameter is `PingValue`, not `unknown`: under `strictFunctionTypes`
 * parameters are contravariant, and postgres.js's own template overload takes
 * `ParameterOrFragment`, so an `unknown` rest makes `Sql` unassignable to this
 * type. `PingValue` keeps interpolation usable while staying assignable.
 */
export type DatabasePing = (
  strings: TemplateStringsArray,
  ...values: PingValue[]
) => Promise<unknown>;

/**
 * The composition root's contract, declared against PORTS rather than inferred
 * from the concrete adapters. Adapter drift now fails at compile time, and
 * use-case tests can inject plain-object fakes without casts.
 */
export interface Dependencies {
  creatorRepository: CreatorRepositoryPort;
  tokenIssuer: TokenIssuerPort;
  payments: PaymentProviderPort;
  registerCreator: RegisterCreator;
  authenticateCreator: AuthenticateCreator;
  createCommunity: CreateCommunity;
  listCommunities: ListCommunities;
  updateCommunity: UpdateCommunity;
  defineTier: DefineMembershipTier;
  listTiers: ListTiers;
  updateTier: UpdateTier;
  connectChannel: ConnectChannel;
  listChannels: ListChannels;
  createPaymentAccount: CreatePaymentAccount;
  getPublicCommunity: GetPublicCommunity;
  startCheckout: StartCheckout;
  getSubscriptionStatus: GetSubscriptionStatus;
  handlePaymentWebhook: HandlePaymentWebhook;
  /**
   * Phase 6's creator dashboard reads. All three go through
   * `AnalyticsRepositoryPort`, whose every method is creator-scoped and which has
   * no unscoped variant — see the port for why that absence is the protection.
   */
  getCommunityMetrics: GetCommunityMetrics;
  getCommunityActivity: GetCommunityActivity;
  /**
   * The creator's manual "remove this member" action. It lives in the API rather
   * than the worker because revocation is SYNCHRONOUS: a creator removing someone
   * expects to be told whether it worked (see the use-case docstring). That is
   * also why the API selects messaging providers at all — the grant path never
   * calls one from this process.
   */
  revokeChannelAccess: RevokeChannelAccess;
  /**
   * Attaches a joining member's Telegram user id to the membership whose
   * single-use invite link they used. It lives in the API rather than the worker
   * because it is driven by an INBOUND webhook — see routes/webhooks.ts for why a
   * webhook rather than a `getUpdates` poll.
   *
   * Without it `channel_membership.external_member_id` is NULL forever and
   * `RevokeChannelAccess` can only report `no_provider_member_id_recorded`.
   */
  recordChannelJoin: RecordChannelJoin;
  /**
   * Phase 5's renewal reminder delivery.
   *
   * The DISPATCHER lives in the worker — `bootstrapWorker` registers it against the
   * `send_renewal_reminder` outbox event type, and this process claims no outbox rows.
   * It is constructed here anyway, and exposed, for the reason `messaging` and
   * `payments` are: so a test can prove what THIS process wired. Specifically that the
   * reminder's checkout link is built from the same resolved `appBaseUrl` this root
   * hands `StartCheckout` for `success_redirect_url` — the two must never disagree
   * about which deployment a member is sent to, and the only way to check that is to
   * be able to see both from one place.
   *
   * Phase 4's lesson, restated: a guard that exists in the API and has never crossed
   * the workspace seam is not a guard. Both roots build this use-case, and both are
   * tested.
   */
  sendRenewalReminder: SendRenewalReminder;
  /**
   * The messaging adapters THIS process selected. Exposed for the same reason
   * `payments` and `WorkerDependencies.messaging` are: a test must be able to prove
   * what a given environment actually wired, and — for revocation specifically —
   * that a `revokeAccess` really reached the provider with the member id the join
   * webhook recorded. Reading it off a fake constructed by the test instead would
   * prove only that the test can call the fake.
   */
  messaging: MessagingProviders;
  /**
   * The static secret Telegram sends as `X-Telegram-Bot-Api-Secret-Token`, the
   * ONLY thing authenticating `POST /webhooks/telegram`. `undefined` when the box
   * is not configured for it (never outside the NODE_ENV allowlist —
   * `resolveTelegramWebhookSecret` throws there), in which case
   * `verifyCallbackToken` rejects every delivery rather than accepting any. Not
   * narrowed to `string` for the same reason as `xenditCallbackToken`.
   */
  telegramWebhookSecret: string | undefined;
  /**
   * The static token Xendit sends as `X-CALLBACK-TOKEN`, the ONLY thing
   * authenticating the webhook route. `undefined` when the box is not
   * configured for webhooks (never in production — `resolveCallbackToken`
   * throws there), in which case `verifyCallbackToken` rejects every delivery
   * rather than accepting any. Deliberately NOT narrowed to `string`: that
   * would force a `?? ""` at the call site, and an empty expected token used to
   * match an empty header.
   */
  xenditCallbackToken: string | undefined;
  /**
   * The resolved public origin of `apps/web` — see `resolveAppBaseUrl`. Exposed
   * here rather than kept private inside `StartCheckout` so a test can prove the
   * environment variable actually reaches the composition root: the confirmation
   * page was unreachable for an entire phase because nothing checked the wiring.
   */
  appBaseUrl: string;
  sql: DatabasePing;
}

/**
 * Minimum JWT_SECRET length. HS256 keys shorter than the hash output (32 bytes)
 * weaken the MAC, and a short secret is offline-brute-forceable from a single
 * captured token — which would forge any creator's session, since every
 * creator's session depends on this one key. `openssl rand -base64 32` produces
 * a conforming value.
 */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * The literal in `.env.example`. Copying the example file and forgetting to
 * change this line is the single most likely way a real deployment ends up with
 * a publicly-known signing key, and it is long enough to pass the length check.
 */
const PLACEHOLDER_JWT_SECRET = "change_me_to_a_long_random_string";

export function assertUsableJwtSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Add it to apps/api/.env — see .env.example. " +
        "Refusing to start rather than signing tokens with a default secret."
    );
  }
  if (secret === PLACEHOLDER_JWT_SECRET) {
    throw new Error(
      "JWT_SECRET is still the .env.example placeholder. Generate a real one: " +
        "openssl rand -base64 32"
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} characters; ` +
        `${MIN_JWT_SECRET_LENGTH} required). Generate one: openssl rand -base64 32`
    );
  }
  return secret;
}

/**
 * The ONLY `NODE_ENV` values allowed to reach a relaxed configuration branch:
 * the fake payment adapter, and an absent `XENDIT_CALLBACK_TOKEN`.
 *
 * An ALLOWLIST, deliberately — this is the same shape as `VISIBLE_STATUSES` in
 * get-public-community.ts, for the same reason: an unanticipated value must fail
 * CLOSED. The denylist this replaced (`if (nodeEnv === "production") throw`)
 * looked equivalent and was not, because nothing in this repository ever sets
 * `NODE_ENV`:
 *
 *   $ bun -e 'console.log(process.env.NODE_ENV)'   ->  undefined
 *
 * There is no `start` script, no Dockerfile, and no API service in
 * infra/docker-compose.yml, so the FIRST real deployment would have run with
 * `NODE_ENV` unset and taken the unsafe branch — booting the fake adapter,
 * writing unrecoverable `fake-acct-*` ids into `creator.xendit_account_id`, and
 * rejecting every webhook delivery. `"staging"`, `"prod"` and `"PRODUCTION"`
 * were unsafe for the same reason. Under this allowlist all four throw.
 *
 * `"test"` is in here because `bun test` sets it (the same mechanism
 * `resetDatabase()` relies on) and the whole suite depends on the fake adapter.
 * `"development"` is here so `bun run dev` works — which is why
 * `NODE_ENV=development` is now in `apps/api/.env.example`.
 *
 * Adding a value to this set is a decision to let that environment take fake
 * money. Do not add `"staging"`: a staging box that charges nobody proves
 * nothing about the payment path, and Xendit has a test-mode secret key for it.
 */
export const RELAXED_NODE_ENVS: ReadonlySet<string> = new Set(["development", "test"]);

function isRelaxedNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && RELAXED_NODE_ENVS.has(nodeEnv);
}

/** Renders `NODE_ENV` for an error message, distinguishing unset from a value. */
function describeNodeEnv(nodeEnv: string | undefined): string {
  return nodeEnv === undefined ? "not set" : nodeEnv;
}

/** The names in `RELAXED_NODE_ENVS`, for error messages. */
const RELAXED_NODE_ENVS_LIST = [...RELAXED_NODE_ENVS].sort().join(" or ");

/**
 * Minimum `XENDIT_CALLBACK_TOKEN` length, mirroring `MIN_JWT_SECRET_LENGTH`
 * above on purpose. This token is the ONLY authentication on
 * `POST /webhooks/xendit` — Xendit signs nothing — so it is exactly as
 * load-bearing as the JWT signing key, and it was accepting a value of `"x"`.
 * A short token is brute-forceable against a live endpoint, and forging a
 * callback grants free access to every paid community on the box. Real Xendit
 * dashboard tokens are comfortably longer than this.
 */
const MIN_CALLBACK_TOKEN_LENGTH = 32;

/**
 * Normalises an env var to `undefined` when it carries no value. A variable
 * exported as `XENDIT_SECRET_KEY=` arrives as `""`, which is indistinguishable
 * from a typo'd name in intent but NOT in truthiness once someone writes
 * `env.secretKey !== undefined`. Whitespace-only is treated the same way: a
 * value copied out of a dashboard with a trailing space is not configuration.
 */
function presentOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}

/**
 * Chooses the payment adapter, refusing to start rather than taking fake money.
 *
 * The fake adapter settles nothing while looking, from the outside, exactly
 * like it did. Worse, `CreatePaymentAccount` writes its `fake-acct-*` id into
 * `creator.xendit_account_id` and then 409s forever, so a creator onboarded on
 * a misconfigured production box can never connect a real Xendit sub-account
 * without manual SQL. A `console.log` is not a safety mechanism — these two
 * guards are (see the plan's Global Constraints):
 *
 *   1. PARTIAL configuration throws in EVERY environment. A set secret key with
 *      an unset split rule id is never intentional; it is a typo that makes an
 *      operator believe payments are live.
 *   2. ABSENT configuration throws UNLESS `NODE_ENV` is one of
 *      `RELAXED_NODE_ENVS` — an allowlist, so `undefined`, `"staging"`,
 *      `"prod"` and `"PRODUCTION"` all throw. See RELAXED_NODE_ENVS for why the
 *      denylist this replaced never fired.
 *
 * Mirrors `assertUsableJwtSecret` above in shape and error wording.
 */
export function selectPaymentProvider(env: {
  secretKey: string | undefined;
  splitRuleId: string | undefined;
  nodeEnv: string | undefined;
}): PaymentProviderPort {
  const secretKey = presentOrUndefined(env.secretKey);
  const splitRuleId = presentOrUndefined(env.splitRuleId);

  if (secretKey && splitRuleId) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] payments provider: XenditPaymentAdapter " +
        "(XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are set — real money will move)"
    );
    return new XenditPaymentAdapter({ secretKey, splitRuleId });
  }

  if (secretKey || splitRuleId) {
    const missing = secretKey ? "XENDIT_SPLIT_RULE_ID" : "XENDIT_SECRET_KEY";
    const present = secretKey ? "XENDIT_SECRET_KEY" : "XENDIT_SPLIT_RULE_ID";
    throw new Error(
      `Xendit is half-configured: ${present} is set but ${missing} is not. ` +
        "Set both or neither — see apps/api/.env.example. Refusing to start rather " +
        "than falling back to the fake payment adapter while looking configured."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. The fake payment adapter is permitted ONLY ` +
        `when NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}. Add the keys to ` +
        "apps/api/.env — see .env.example — or set NODE_ENV=development. Refusing to " +
        "start rather than taking fake payments and writing unrecoverable fake-acct-* " +
        "ids into creator.xendit_account_id."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] payments provider: FakePaymentAdapter " +
      "(XENDIT_SECRET_KEY/XENDIT_SPLIT_RULE_ID not set — no real money will move; " +
      "set both to switch to the real Xendit adapter)"
  );
  return new FakePaymentAdapter();
}

/**
 * The messaging providers a process needs to turn a payment into access.
 *
 * Two fields rather than one map, because notifying and gating are different
 * capabilities and conflating them is a real bug: `TelegramBotAdapter.notify`
 * THROWS (it addresses a WhatsApp number it cannot reach), so a member who paid
 * would never be told anything.
 */
export interface MessagingProviders {
  /**
   * Gating providers keyed by `channel.platform`.
   *
   * WhatsApp is in here too, even though it cannot gate: a `whatsapp` channel must
   * resolve to a provider that reports `canGateAccess: false` — which
   * `GrantChannelAccess` turns into "a human will add you", recorded in
   * `activity_log` — rather than to nothing, which it treats as an unwired
   * platform and an error.
   */
  gating: ReadonlyMap<string, MessagingProviderPort>;
  /** How the MEMBER is reached. WhatsApp, always. */
  notifier: MessagingProviderPort;
}

/**
 * Chooses the messaging adapters, refusing to start rather than pretending to
 * invite anyone.
 *
 * Deliberately the same shape, thresholds and reasoning as
 * `selectPaymentProvider` above:
 *
 *   1. Both tokens set -> the real adapters, in every environment.
 *   2. PARTIAL configuration throws EVERYWHERE. A Telegram token with no Fonnte
 *      token mints a single-use invite link and has no way to deliver it: the
 *      member pays, a credential is created, and nobody is told. A Fonnte token
 *      with no Telegram token notifies members that they have access to a group
 *      nothing ever added them to.
 *   3. ABSENT configuration selects `FakeMessagingAdapter` ONLY when `NODE_ENV`
 *      is in `RELAXED_NODE_ENVS` — so `undefined`, `"staging"`, `"prod"` and
 *      `"production"` all throw. The fake records sends into an array instead of
 *      making them, so a box running it looks exactly like a working one from the
 *      outside while every paying member waits for a message that will never
 *      arrive. That is this phase's worst failure mode (plan, Global
 *      Constraints), and it is worth refusing to boot over.
 *
 * Both tokens are bearer credentials — the Telegram one is part of every Bot API
 * request PATH — so the startup line names the adapters and never the values.
 */
export function selectMessagingProviders(env: {
  telegramBotToken: string | undefined;
  fonnteApiToken: string | undefined;
  nodeEnv: string | undefined;
}): MessagingProviders {
  const telegramBotToken = presentOrUndefined(env.telegramBotToken);
  const fonnteApiToken = presentOrUndefined(env.fonnteApiToken);

  if (telegramBotToken && fonnteApiToken) {
    logProviderChoice(
      env.nodeEnv,
      "[bootstrap] messaging providers: TelegramBotAdapter (gating) + FonnteWhatsAppAdapter " +
        "(notification) — TELEGRAM_BOT_TOKEN and FONNTE_API_TOKEN are set, so real invites " +
        "will be issued and real messages sent"
    );
    const notifier = new FonnteWhatsAppAdapter({ apiToken: fonnteApiToken });
    return {
      gating: new Map<string, MessagingProviderPort>([
        ["telegram", new TelegramBotAdapter({ botToken: telegramBotToken })],
        ["whatsapp", notifier],
      ]),
      notifier,
    };
  }

  if (telegramBotToken || fonnteApiToken) {
    const missing = telegramBotToken ? "FONNTE_API_TOKEN" : "TELEGRAM_BOT_TOKEN";
    const present = telegramBotToken ? "TELEGRAM_BOT_TOKEN" : "FONNTE_API_TOKEN";
    throw new Error(
      `Messaging is half-configured: ${present} is set but ${missing} is not. Set both or ` +
        "neither — see apps/api/.env.example. Refusing to start rather than issuing invite " +
        "links nobody can be told about, or telling members about access nobody granted."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and FONNTE_API_TOKEN are not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. FakeMessagingAdapter is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}: it appends sends to an array, so a ` +
        "box running it looks like it is inviting paying members while nobody receives " +
        "anything. Add the tokens to apps/api/.env — see .env.example — or set " +
        "NODE_ENV=development."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] messaging providers: FakeMessagingAdapter for both gating and notification " +
      "(TELEGRAM_BOT_TOKEN/FONNTE_API_TOKEN not set — no invite is issued and no message is " +
      "sent; set both to switch to the real adapters)"
  );
  const fakeNotifier = new FakeMessagingAdapter({ platform: "whatsapp", canGateAccess: false });
  return {
    gating: new Map<string, MessagingProviderPort>([
      ["telegram", new FakeMessagingAdapter({ platform: "telegram", canGateAccess: true })],
      ["whatsapp", fakeNotifier],
    ]),
    notifier: fakeNotifier,
  };
}

/**
 * The token `resolveCallbackToken` hands back under `NODE_ENV=test`, and the
 * one value it refuses to accept anywhere else. It is committed to this
 * repository, so treating it as a real secret would mean shipping a publicly
 * known webhook password — the same failure mode as the `.env.example`
 * `JWT_SECRET` placeholder.
 */
export const TEST_CALLBACK_TOKEN = "test-callback-token";

/**
 * Resolves the static token that is the ONLY authentication on
 * `POST /webhooks/xendit`.
 *
 * Nothing read `XENDIT_CALLBACK_TOKEN` before Task 7, so it sat outside the
 * configuration guard above. It is now inside it, and deliberately shaped like
 * `selectPaymentProvider` rather than like `assertUsableJwtSecret` — same three
 * cases, same thresholds (owner ruling, 2026-08-09):
 *
 *   1. A configured token is used as-is. Empty and whitespace-only count as
 *      unset (`XENDIT_CALLBACK_TOKEN=` in a .env file arrives as `""`).
 *   2. PARTIAL configuration throws in EVERY environment. A box with
 *      XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID set is taking real money; if
 *      it cannot authenticate the callback that credits that money, no member
 *      it charges is ever activated. Same reasoning as the half-configured
 *      check in `selectPaymentProvider`, extended to the third variable.
 *   3. ABSENT configuration returns `undefined` when `NODE_ENV` is one of
 *      `RELAXED_NODE_ENVS`, and throws for EVERYTHING else — `undefined`,
 *      `"staging"`, `"prod"`, `"PRODUCTION"`. A developer must be able to
 *      `bun run dev` without setting a variable for an endpoint they may never
 *      exercise locally, exactly as they can without the Xendit keys; nobody
 *      else gets that.
 *   4. A configured token shorter than `MIN_CALLBACK_TOKEN_LENGTH` throws in
 *      every environment, exactly as a short `JWT_SECRET` does.
 *
 * `undefined` is safe to return, and is why `verifyCallbackToken` takes
 * `string | undefined`: it refuses an unset or empty `expected` before any
 * comparison, so an unconfigured box rejects every webhook rather than
 * accepting every forged one. It fails closed — the guard exists so that
 * production fails LOUDLY instead.
 *
 * Plus one rule the JWT secret taught us: the test default is refused outside
 * tests, so `XENDIT_CALLBACK_TOKEN=test-callback-token` on a production box —
 * a value anyone can read in this file — cannot vouch for a payment.
 */
export function resolveCallbackToken(env: {
  callbackToken: string | undefined;
  secretKey: string | undefined;
  splitRuleId: string | undefined;
  nodeEnv: string | undefined;
}): string | undefined {
  const token = presentOrUndefined(env.callbackToken);

  if (token !== undefined) {
    if (token === TEST_CALLBACK_TOKEN) {
      if (env.nodeEnv !== "test") {
        throw new Error(
          "XENDIT_CALLBACK_TOKEN is the value committed to this repository for tests. " +
            "Anyone can read it, so it would authenticate a forged payment event. Use the " +
            "callback token from the Xendit dashboard."
        );
      }
      // Exempt from the length floor below: it is the suite's own known value,
      // and it is already refused everywhere else by the branch above.
      return token;
    }
    if (token.length < MIN_CALLBACK_TOKEN_LENGTH) {
      throw new Error(
        `XENDIT_CALLBACK_TOKEN is too short (${token.length} characters; ` +
          `${MIN_CALLBACK_TOKEN_LENGTH} required). It is the ONLY authentication on ` +
          "POST /webhooks/xendit, so a guessable value grants free access to every paid " +
          "community. Copy the full token from Settings → Developers → Webhooks in the " +
          "Xendit dashboard."
      );
    }
    return token;
  }

  // Checked before the production rule so the suite, which never sets the
  // variable, keeps working even when a test hands `selectPaymentProvider` a
  // fully-configured Xendit environment.
  if (env.nodeEnv === "test") {
    return TEST_CALLBACK_TOKEN;
  }

  if (presentOrUndefined(env.secretKey) && presentOrUndefined(env.splitRuleId)) {
    throw new Error(
      "Xendit is half-configured: XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are set " +
        "but XENDIT_CALLBACK_TOKEN is not. Real invoices would be created and no " +
        "callback could be authenticated, so no member who paid would ever be " +
        "activated. Set all three — see apps/api/.env.example."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "XENDIT_CALLBACK_TOKEN is not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. Booting without it is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}. Add it to apps/api/.env — see ` +
        ".env.example, and copy the callback token from the Xendit dashboard — or set " +
        "NODE_ENV=development. Refusing to start rather than serving a webhook endpoint " +
        "that rejects every real payment."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] XENDIT_CALLBACK_TOKEN not set — POST /webhooks/xendit will reject " +
      "every delivery. Set it to test the webhook path locally."
  );
  return undefined;
}

/**
 * The secret `resolveTelegramWebhookSecret` hands back under `NODE_ENV=test`, and
 * the one value it refuses to accept anywhere else — same rule, and the same
 * reason, as `TEST_CALLBACK_TOKEN` above: it is committed to this repository, so
 * treating it as real would ship a publicly known webhook password.
 */
export const TEST_TELEGRAM_WEBHOOK_SECRET = "test-telegram-webhook-secret";

/**
 * Minimum `TELEGRAM_WEBHOOK_SECRET` length, mirroring `MIN_CALLBACK_TOKEN_LENGTH`
 * and `MIN_JWT_SECRET_LENGTH` on purpose. This secret is the ONLY authentication
 * on `POST /webhooks/telegram`, and forging a `chat_member` update means writing
 * an attacker-chosen `external_member_id` onto a membership — which is the id
 * `banChatMember` is aimed at, so it would turn a revocation into "remove somebody
 * else from the creator's group".
 */
const MIN_TELEGRAM_WEBHOOK_SECRET_LENGTH = 32;

/**
 * Characters Telegram's `setWebhook` accepts in `secret_token`: 1–256 of
 * `A-Z a-z 0-9 _ -`. Checked here so a secret with a space or a `+` in it fails at
 * BOOT with an explanation, rather than as an opaque 400 from `setWebhook` on a
 * box where the endpoint then rejects every real delivery.
 */
const TELEGRAM_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Resolves the static secret that is the ONLY authentication on
 * `POST /webhooks/telegram`, delivered in the `X-Telegram-Bot-Api-Secret-Token`
 * header that `setWebhook`'s `secret_token` parameter installs.
 *
 * Deliberately the same four cases, thresholds and wording as
 * `resolveCallbackToken` above, because it is the same kind of thing: a STATIC
 * token that authenticates the sender and not the message.
 *
 *   1. A configured secret is used as-is (empty and whitespace-only count as
 *      unset), subject to the length floor and Telegram's charset.
 *   2. PARTIAL configuration throws in EVERY environment. A box with
 *      `TELEGRAM_BOT_TOKEN` set is gating real Telegram groups; without this
 *      secret the join endpoint rejects every delivery, so no
 *      `external_member_id` is ever recorded and revocation can never be
 *      automated — the exact gap this feature exists to close.
 *   3. ABSENT configuration returns `undefined` when `NODE_ENV` is one of
 *      `RELAXED_NODE_ENVS`, and throws for EVERYTHING else — `undefined`,
 *      `"staging"`, `"prod"`, `"PRODUCTION"`. A developer must be able to
 *      `bun run dev` without a public URL to point Telegram at.
 *   4. The committed test value is refused outside `NODE_ENV=test`.
 *
 * `undefined` fails CLOSED: `verifyCallbackToken` refuses an unset `expected`
 * before any comparison, so an unconfigured box rejects every update rather than
 * accepting every forged one.
 */
export function resolveTelegramWebhookSecret(env: {
  webhookSecret: string | undefined;
  telegramBotToken: string | undefined;
  nodeEnv: string | undefined;
}): string | undefined {
  const secret = presentOrUndefined(env.webhookSecret);

  if (secret !== undefined) {
    if (secret === TEST_TELEGRAM_WEBHOOK_SECRET) {
      if (env.nodeEnv !== "test") {
        throw new Error(
          "TELEGRAM_WEBHOOK_SECRET is the value committed to this repository for tests. " +
            "Anyone can read it, so it would authenticate a forged chat_member update — and " +
            "that update writes the very user id banChatMember is aimed at. Generate a real " +
            "one: openssl rand -hex 32"
        );
      }
      // Exempt from the length floor: it is the suite's own known value, and it is
      // already refused everywhere else by the branch above.
      return secret;
    }
    if (secret.length < MIN_TELEGRAM_WEBHOOK_SECRET_LENGTH) {
      throw new Error(
        `TELEGRAM_WEBHOOK_SECRET is too short (${secret.length} characters; ` +
          `${MIN_TELEGRAM_WEBHOOK_SECRET_LENGTH} required). It is the ONLY authentication on ` +
          "POST /webhooks/telegram, and a forged update writes an attacker-chosen member id " +
          "onto a membership. Generate one: openssl rand -hex 32"
      );
    }
    if (!TELEGRAM_WEBHOOK_SECRET_PATTERN.test(secret)) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET contains characters Telegram's setWebhook will not accept " +
          "(only A-Z, a-z, 0-9, _ and - are allowed, 1-256 of them). Refusing to start " +
          "rather than serving an endpoint whose secret can never be installed. Generate " +
          "one: openssl rand -hex 32"
      );
    }
    return secret;
  }

  // Before the production rule, so the suite — which never sets the variable —
  // keeps working even when a test hands this a configured bot token.
  if (env.nodeEnv === "test") {
    return TEST_TELEGRAM_WEBHOOK_SECRET;
  }

  if (presentOrUndefined(env.telegramBotToken)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is not. Real invite links " +
        "would be issued and no chat_member update could be authenticated, so no member's " +
        "Telegram user id would ever be recorded — and RevokeChannelAccess needs one, so " +
        "the creator could never remove anybody. Set both — see apps/api/.env.example."
    );
  }

  if (!isRelaxedNodeEnv(env.nodeEnv)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET is not set, and NODE_ENV is " +
        `${describeNodeEnv(env.nodeEnv)}. Booting without it is permitted ONLY when ` +
        `NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}. Add it to apps/api/.env — see ` +
        ".env.example — or set NODE_ENV=development. Refusing to start rather than serving " +
        "a webhook endpoint that rejects every real delivery."
    );
  }

  logProviderChoice(
    env.nodeEnv,
    "[bootstrap] TELEGRAM_WEBHOOK_SECRET not set — POST /webhooks/telegram will reject " +
      "every delivery, so no member's Telegram user id will be recorded and revocation " +
      "cannot be automated. Set it (and setWebhook's secret_token to match) to exercise it."
  );
  return undefined;
}

/**
 * The `APP_BASE_URL` a developer gets for free: Vite's default dev-server
 * origin, which is what `apps/web` serves the confirmation page from.
 */
export const DEFAULT_APP_BASE_URL = "http://localhost:5173";

/**
 * Resolves the public origin of `apps/web`, used to build the
 * `success_redirect_url` the payment provider sends the payer back to:
 * `<base>/c/<slug>/status/<subscriptionId>`.
 *
 * Same allowlist rule as the two guards above (see RELAXED_NODE_ENVS): the
 * localhost default is permitted only under `development`/`test`. Anywhere else
 * it must be set, because a deployment silently falling back to
 * `http://localhost:5173` sends every paying member to a page on their OWN
 * machine — a failure that looks like the payment vanished, and one no test on a
 * developer's laptop would ever surface.
 *
 * A trailing slash is stripped so callers can concatenate a rooted path without
 * producing `//c/...`.
 */
export function resolveAppBaseUrl(env: {
  appBaseUrl: string | undefined;
  nodeEnv: string | undefined;
}): string {
  const configured = presentOrUndefined(env.appBaseUrl);

  if (configured === undefined) {
    if (!isRelaxedNodeEnv(env.nodeEnv)) {
      throw new Error(
        "APP_BASE_URL is not set, and NODE_ENV is " +
          `${describeNodeEnv(env.nodeEnv)}. Falling back to ${DEFAULT_APP_BASE_URL} is ` +
          `permitted ONLY when NODE_ENV is exactly ${RELAXED_NODE_ENVS_LIST}: it is the ` +
          "URL the payment provider sends a paying member back to, so a localhost " +
          "default would strand every payer on their own machine. Add it to " +
          "apps/api/.env — see .env.example."
      );
    }
    return DEFAULT_APP_BASE_URL;
  }

  const trimmed = configured.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error(
      `APP_BASE_URL must start with https:// or http:// (got "${trimmed}"). It is ` +
        "concatenated into a URL the payment provider redirects a browser to."
    );
  }
  return trimmed;
}

/**
 * Silent under `NODE_ENV=test` only. `bootstrap()` is called once per test that
 * builds an app, so this line printed 100+ times in one suite run and buried a
 * genuine `unhandled error` line. Everywhere else it still prints: the guards
 * above are the safety mechanism, but an operator reading startup output should
 * still see which adapter is live.
 */
function logProviderChoice(nodeEnv: string | undefined, message: string): void {
  if (nodeEnv === "test") return;
  console.log(message);
}

export function bootstrap(): Dependencies {
  const jwtSecret = assertUsableJwtSecret(process.env.JWT_SECRET);

  const creatorRepository = new DrizzleCreatorRepository(db);
  const passwordHasher = new BunPasswordHasher();
  const tokenIssuer = new HonoJwtTokenIssuer(jwtSecret);
  const registerCreator = new RegisterCreator(creatorRepository, passwordHasher, tokenIssuer);
  const authenticateCreator = new AuthenticateCreator(
    creatorRepository,
    passwordHasher,
    tokenIssuer
  );

  const communityRepository = new DrizzleCommunityRepository(db);
  const createCommunity = new CreateCommunity(communityRepository);
  const listCommunities = new ListCommunities(communityRepository);
  const updateCommunity = new UpdateCommunity(communityRepository);

  const tierRepository = new DrizzleMembershipTierRepository(db);
  const defineTier = new DefineMembershipTier(communityRepository, tierRepository);
  const listTiers = new ListTiers(communityRepository, tierRepository);
  const updateTier = new UpdateTier(communityRepository, tierRepository);

  const channelRepository = new DrizzleChannelRepository(db);
  const connectChannel = new ConnectChannel(communityRepository, channelRepository);
  const listChannels = new ListChannels(communityRepository, channelRepository);

  const payments: PaymentProviderPort = selectPaymentProvider({
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  });
  const createPaymentAccount = new CreatePaymentAccount(creatorRepository, payments);
  // After selectPaymentProvider on purpose: on a production box with nothing
  // configured at all, "you are about to take fake money" is the more urgent of
  // the two messages, and the existing test pins that wording.
  const xenditCallbackToken = resolveCallbackToken({
    callbackToken: process.env.XENDIT_CALLBACK_TOKEN,
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  });

  const getPublicCommunity = new GetPublicCommunity(communityRepository, tierRepository);

  const memberRepository = new DrizzleMemberRepository(db);
  const subscriptionRepository = new DrizzleSubscriptionRepository(db);
  const appBaseUrl = resolveAppBaseUrl({
    appBaseUrl: process.env.APP_BASE_URL,
    nodeEnv: process.env.NODE_ENV,
  });
  // ONE clock for the process. Phase 5's use-cases read time through it rather than
  // calling `Date.now()`, so the renewal window and the settlement date a member's next
  // period is measured from are both observable in a test.
  const clock = new SystemClock();
  const startCheckout = new StartCheckout(
    communityRepository,
    tierRepository,
    memberRepository,
    subscriptionRepository,
    creatorRepository,
    payments,
    clock,
    { appBaseUrl }
  );
  const getSubscriptionStatus = new GetSubscriptionStatus(subscriptionRepository);

  // The webhook's three writes commit together or not at all — see
  // PaymentActivationUnitOfWorkPort. The read that precedes them uses the
  // pooled repository directly.
  const paymentActivationUnitOfWork = new DrizzlePaymentActivationUnitOfWork(db);
  const handlePaymentWebhook = new HandlePaymentWebhook(
    subscriptionRepository,
    paymentActivationUnitOfWork,
    clock
  );

  // Phase 6's dashboard reads. One repository, three use-cases, every method
  // creator-scoped at the port.
  const analyticsRepository = new DrizzleAnalyticsRepository(db);
  const getCommunityMetrics = new GetCommunityMetrics(analyticsRepository);
  const getCommunityActivity = new GetCommunityActivity(analyticsRepository);

  // Revocation is the ONE messaging call the API process makes; granting happens
  // in apps/worker. Same allowlist as the payment adapter: on a box with no
  // tokens and a NODE_ENV outside the allowlist this throws rather than booting a
  // fake that would report a removal it never performed.
  const messaging = selectMessagingProviders({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    fonnteApiToken: process.env.FONNTE_API_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });
  const channelMembershipRepository = new DrizzleChannelMembershipRepository(db);
  const revokeChannelAccess = new RevokeChannelAccess(
    communityRepository,
    channelMembershipRepository,
    new DrizzleActivityLogRepository(db),
    messaging.gating,
    // A removal the provider could not perform is enqueued here, and apps/worker
    // retries it — see OUTBOX_REVOKE_ACCESS. The POOLED client: this use-case is
    // synchronous and opens no transaction, so an outbox failure must not be able to
    // undo a revocation the creator has already been told about.
    new DrizzleOutboxRepository(db)
  );

  // The other half of revocation, and the half that was missing: without a
  // recorded platform member id, `revokeChannelAccess` above can only ever report
  // `no_provider_member_id_recorded`.
  const recordChannelJoin = new RecordChannelJoin(channelMembershipRepository);

  // Phase 5. Built with the SAME `appBaseUrl` StartCheckout received above, and with
  // `messaging.notifier` rather than a gating provider: `TelegramBotAdapter.notify`
  // throws. See the `sendRenewalReminder` field on `Dependencies` for why the API root
  // builds a use-case the worker dispatches.
  const sendRenewalReminder = new SendRenewalReminder(
    subscriptionRepository,
    memberRepository,
    new DrizzleActivityLogRepository(db),
    messaging.notifier,
    { appBaseUrl }
  );
  const telegramWebhookSecret = resolveTelegramWebhookSecret({
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });

  return {
    creatorRepository,
    tokenIssuer,
    payments,
    registerCreator,
    authenticateCreator,
    createCommunity,
    listCommunities,
    updateCommunity,
    defineTier,
    listTiers,
    updateTier,
    connectChannel,
    listChannels,
    createPaymentAccount,
    getPublicCommunity,
    startCheckout,
    getSubscriptionStatus,
    handlePaymentWebhook,
    getCommunityMetrics,
    getCommunityActivity,
    revokeChannelAccess,
    recordChannelJoin,
    sendRenewalReminder,
    messaging,
    telegramWebhookSecret,
    xenditCallbackToken,
    appBaseUrl,
    sql,
  };
}
