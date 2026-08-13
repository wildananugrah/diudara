import { and, eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { communities } from "../../db/schema";
import { UniqueRule } from "../../application/errors";
import { rethrowUniqueViolation } from "./pg-errors";
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
    accessMode?: string;
  }): Promise<CommunityRecord> {
    try {
      const [row] = await this.db
        .insert(communities)
        .values({
          creatorId: input.creatorId,
          name: input.name,
          slug: input.slug,
          niche: input.niche,
          // Omitted entirely (rather than passed through as `undefined`) when
          // not provided, so the column's own `DEFAULT 'paid'` applies —
          // exactly the CreateCommunity-with-no-accessMode case a
          // payments-disabled box must still refuse before ever reaching
          // this line (see CreateCommunity's own guard).
          ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
        })
        .returning();
      return row;
    } catch (err) {
      // The slug namespace is global across creators, so `slugExists` +
      // `insert` is a race any two concurrent creates can lose. CreateCommunity
      // retries on this; see its comment.
      rethrowUniqueViolation(err, {
        community_slug_unique: {
          rule: UniqueRule.communitySlug,
          message: "slug is already taken",
        },
      });
    }
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

  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    const [row] = await this.db
      .select()
      .from(communities)
      .where(eq(communities.slug, slug))
      .limit(1);
    return row ?? null;
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
    try {
      const [row] = await this.db
        .update(communities)
        .set(patch)
        .where(and(eq(communities.id, id), eq(communities.creatorId, creatorId)))
        .returning();
      return row ?? null;
    } catch (err) {
      // UpdateCommunity pre-checks `slugExists`, which is the same TOCTOU as on
      // create. Mapping it here means a lost race is the same 409 the pre-check
      // would have produced, instead of a 500.
      rethrowUniqueViolation(err, {
        community_slug_unique: {
          rule: UniqueRule.communitySlug,
          message: "slug is already taken",
        },
      });
    }
  }
}
