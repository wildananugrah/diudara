import { createCommunitySchema } from "@diudara/shared";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  isReservedCommunitySlug,
  slugifyCommunityName,
} from "../../domain/community-slug";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import { toCommunityDetail, type CommunityDetail } from "./community-detail";

/**
 * A name that slugs to nothing — "!!! ???" — is not a server error, it is a
 * name the user has to change, so it says so.
 */
const UNSLUGGABLE_MESSAGE = "nama harus mengandung huruf atau angka";
/** A slug that would collide with a real route. See `RESERVED_COMMUNITY_SLUGS`. */
const RESERVED_SLUG_MESSAGE = "nama ini tidak bisa dipakai, coba nama lain";
/** The unique index refused it — somebody else got there first. */
const TAKEN_SLUG_MESSAGE = "nama ini sudah dipakai komunitas lain";

/**
 * `POST /communities`.
 *
 * **The preconditions this class exists to enforce.** The slug is derived
 * from the name, and two of its possible values must never reach the
 * repository: the empty string, which would hit a NOT NULL/length constraint,
 * and a reserved slug, which no constraint knows about at all and which would
 * be accepted straight into an unreachable URL. Both are rejected here, and
 * `create-community.test.ts` asserts the repository's call count stays at
 * zero for each — the same discipline `FollowUser` applies to a self-follow,
 * and for the same reason: a raw constraint violation aborts an enclosing
 * transaction, so the guard belongs above the write, not under it.
 *
 * The third failure, a slug somebody else already holds, CANNOT be guarded
 * this way: a read-then-write pre-check is a TOCTOU race, and two people
 * naming a community the same thing in the same second both pass it. That one
 * is left to `community_slug_unique`, which the repository translates into a
 * `UniqueViolationError` — a `ConflictError` — and it is re-thrown here with
 * the message a person should read rather than the adapter's.
 */
export class CreateCommunity {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly communities: CommunityRepositoryPort
  ) {}

  async execute(input: {
    ownerId: string;
    name: string;
    category: string;
    description: string | null;
  }): Promise<CommunityDetail> {
    // Parsed here as well as at the route: this use-case's contract is the
    // schema's, and a second caller (a seed script, a future import) must not
    // be able to write a row the HTTP path could never have produced.
    const parsed = createCommunitySchema.safeParse({
      name: input.name,
      category: input.category,
      description: input.description ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError("data komunitas tidak valid");
    }

    const slug = slugifyCommunityName(parsed.data.name);
    if (slug === "") {
      throw new ValidationError(UNSLUGGABLE_MESSAGE);
    }
    if (isReservedCommunitySlug(slug)) {
      throw new ConflictError(RESERVED_SLUG_MESSAGE);
    }

    const owner = await this.users.findById(input.ownerId);
    if (!owner) {
      throw new NotFoundError("user not found");
    }

    let community;
    try {
      community = await this.communities.create({
        ownerId: input.ownerId,
        slug,
        name: parsed.data.name,
        category: parsed.data.category,
        description: parsed.data.description ?? null,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new ConflictError(TAKEN_SLUG_MESSAGE);
      }
      throw err;
    }

    // No queries for these three. The repository just wrote the owner's
    // membership row in the same transaction as the community, so the count
    // is one and the creator is both member and owner by construction.
    return toCommunityDetail({
      community,
      memberCount: 1,
      ownerHandle: owner.handle,
      ownerDisplayName: owner.displayName,
      viewerIsMember: true,
      viewerIsOwner: true,
    });
  }
}
