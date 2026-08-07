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
import type { CreatorRepositoryPort } from "./application/ports/creator-repository.port";
import type { TokenIssuerPort } from "./application/ports/token-issuer.port";

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
  registerCreator: RegisterCreator;
  authenticateCreator: AuthenticateCreator;
  createCommunity: CreateCommunity;
  listCommunities: ListCommunities;
  updateCommunity: UpdateCommunity;
  defineTier: DefineMembershipTier;
  listTiers: ListTiers;
  updateTier: UpdateTier;
  sql: DatabasePing;
}

export function bootstrap(): Dependencies {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      "JWT_SECRET is not set. Add it to apps/api/.env — see .env.example. " +
        "Refusing to start rather than signing tokens with a default secret."
    );
  }

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

  return {
    creatorRepository,
    tokenIssuer,
    registerCreator,
    authenticateCreator,
    createCommunity,
    listCommunities,
    updateCommunity,
    defineTier,
    listTiers,
    updateTier,
    sql,
  };
}
