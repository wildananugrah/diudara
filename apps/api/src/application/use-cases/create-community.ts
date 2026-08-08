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

export class CreateCommunity {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    creatorId: string;
    name: string;
    niche?: string;
  }): Promise<CommunityRecord> {
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
