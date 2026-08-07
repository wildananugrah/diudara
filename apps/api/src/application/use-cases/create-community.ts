import { resolveSlugCollision, slugify } from "../../domain/slug";
import type {
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export class CreateCommunity {
  constructor(private readonly communities: CommunityRepositoryPort) {}

  async execute(input: {
    creatorId: string;
    name: string;
    niche?: string;
  }): Promise<CommunityRecord> {
    const slug = await resolveSlugCollision(slugify(input.name), (candidate) =>
      this.communities.slugExists(candidate)
    );

    return this.communities.create({
      creatorId: input.creatorId,
      name: input.name,
      slug,
      niche: input.niche,
    });
  }
}
