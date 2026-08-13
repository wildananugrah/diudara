import { resolveSlugCollision, slugify } from "../../domain/slug";
import { ConflictError, UniqueRule, UniqueViolationError } from "../errors";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

/**
 * How many times to re-resolve the slug after the database rejects the insert.
 * Bounded on purpose: an unbounded loop would spin forever if the violation
 * ever came from something other than a lost race.
 */
const MAX_SLUG_ATTEMPTS = 8;

export interface CreateCommunityOptions {
  /**
   * Whether this process has a real payment path — `payments !== null` from
   * `selectPaymentProvider` (see bootstrap.ts). Defaults to `true` so every
   * existing caller/test that predates `access_mode` and never passes this
   * option keeps its old, unguarded behaviour.
   *
   * When `false`, a community created with `accessMode: "paid"` — OR with no
   * `accessMode` at all, since `communities.access_mode` defaults to `"paid"`
   * in the database — would have no join path whatsoever: `StartCheckout` is
   * not even constructed on a box with payments disabled, and (by design) a
   * `paid` community never falls back to the free request form either. Refusing
   * the create up front is the only way to avoid silently producing a
   * community nobody can ever join.
   */
  paymentsEnabled?: boolean;
}

export class CreateCommunity {
  private readonly paymentsEnabled: boolean;

  constructor(
    private readonly communities: CommunityRepositoryPort,
    options: CreateCommunityOptions = {}
  ) {
    this.paymentsEnabled = options.paymentsEnabled ?? true;
  }

  async execute(input: {
    creatorId: string;
    name: string;
    niche?: string;
    accessMode?: "paid" | "request";
  }): Promise<CommunityRecord> {
    // Missing accessMode is treated the same as "paid": that is what the
    // database column defaults to, and a silent "request" fallback here would
    // hand out free memberships nobody asked for.
    if (!this.paymentsEnabled && input.accessMode !== "request") {
      throw new ConflictError(
        "pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat"
      );
    }

    const base = slugify(input.name);

    // `slugExists` + `create` is check-then-act: concurrent creates of the same
    // name all see the slug as free and all try to insert it. The slug namespace
    // is GLOBAL across creators, so unrelated creators collide too. The unique
    // constraint — not the pre-check — is the source of truth; when it fires,
    // re-resolve against the now-larger set of taken slugs and try again.
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = await resolveSlugCollision(base, (candidate) =>
        this.communities.slugExists(candidate)
      );

      try {
        return await this.communities.create({
          creatorId: input.creatorId,
          name: input.name,
          slug,
          niche: input.niche,
        });
      } catch (err) {
        const lostTheRace =
          err instanceof UniqueViolationError && err.rule === UniqueRule.communitySlug;
        if (!lostTheRace || attempt === MAX_SLUG_ATTEMPTS) {
          throw err;
        }
      }
    }

    // Unreachable: the loop either returns or throws. Present so the function
    // type-checks without an assertion.
    throw new ConflictError("could not allocate a unique slug");
  }
}
