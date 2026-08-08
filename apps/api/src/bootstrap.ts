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
import { FakePaymentAdapter } from "./infrastructure/payments/fake-payment.adapter";
import { XenditPaymentAdapter } from "./infrastructure/payments/xendit-payment.adapter";
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
 *   2. ABSENT configuration throws when `NODE_ENV === "production"`. Outside
 *      production the fake adapter is the point, and every test relies on it.
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

  if (env.nodeEnv === "production") {
    throw new Error(
      "XENDIT_SECRET_KEY and XENDIT_SPLIT_RULE_ID are not set, and NODE_ENV is " +
        "production. Add them to apps/api/.env — see .env.example. Refusing to start " +
        "rather than taking fake payments and writing unrecoverable fake-acct-* ids " +
        "into creator.xendit_account_id."
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

  const getPublicCommunity = new GetPublicCommunity(communityRepository, tierRepository);

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
    sql,
  };
}
