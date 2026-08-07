import { and, eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { communities } from "../../db/schema";
import type {
  CommunityPatch,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../../application/ports/community-repository.port";

export class DrizzleCommunityRepository implements CommunityRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    creatorId: string;
    name: string;
    slug: string;
    niche?: string;
  }): Promise<CommunityRecord> {
    const [row] = await this.db
      .insert(communities)
      .values({
        creatorId: input.creatorId,
        name: input.name,
        slug: input.slug,
        niche: input.niche,
      })
      .returning();
    return row;
  }

  async findByIdForCreator(id: string, creatorId: string): Promise<CommunityRecord | null> {
    const [row] = await this.db
      .select()
      .from(communities)
      .where(and(eq(communities.id, id), eq(communities.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  async listByCreator(creatorId: string): Promise<CommunityRecord[]> {
    return this.db.select().from(communities).where(eq(communities.creatorId, creatorId));
  }

  async slugExists(slug: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.slug, slug))
      .limit(1);
    return row !== undefined;
  }

  async update(
    id: string,
    creatorId: string,
    patch: CommunityPatch
  ): Promise<CommunityRecord | null> {
    const [row] = await this.db
      .update(communities)
      .set(patch)
      .where(and(eq(communities.id, id), eq(communities.creatorId, creatorId)))
      .returning();
    return row ?? null;
  }
}
