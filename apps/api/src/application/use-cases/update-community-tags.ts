import { updateCommunityTagsSchema } from "@diudara/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";

/**
 * `PATCH /communities/:slug/tags` — a full replace, owner-only.
 *
 * **OWNER ONLY, and a non-owner gets `ForbiddenError`, not `NotFoundError`.**
 * Same reversal `GetCommunityStats` documents: the community's existence is
 * already public, so there is nothing left to conceal by answering 404.
 */
export class UpdateCommunityTags {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: { slug: string; viewerId: string; tags: string[] }): Promise<{ tags: string[] }> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) {
      throw new NotFoundError("komunitas tidak ditemukan");
    }
    if (community.ownerId !== input.viewerId) {
      throw new ForbiddenError("hanya pemilik komunitas yang boleh mengubah tag");
    }

    const parsed = updateCommunityTagsSchema.safeParse({ tags: input.tags });
    if (!parsed.success) {
      throw new ValidationError("tag tidak valid");
    }

    await this.communities.setTags(community.id, parsed.data.tags);
    return { tags: parsed.data.tags };
  }
}
