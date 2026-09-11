import { and, desc, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { userTiers } from "../../db/schema";
import type {
  UserTierRepositoryPort,
  UserTierRow,
} from "../../application/ports/user-tier-repository.port";

export class DrizzleUserTierRepository implements UserTierRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    ownerId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
    communityId?: string;
  }): Promise<UserTierRow> {
    const [row] = await this.db
      .insert(userTiers)
      .values({
        ownerId: input.ownerId,
        name: input.name,
        priceAmount: input.priceAmount,
        billingCycle: input.billingCycle,
        // Spread in ONLY when present, never as `key: undefined` — drizzle
        // turns an explicit undefined into a literal NULL, which is harmless
        // for this nullable column but is the one rule every insert in this
        // repo follows.
        ...(input.communityId === undefined ? {} : { communityId: input.communityId }),
      })
      .returning();
    return row!;
  }

  async findById(id: string): Promise<UserTierRow | null> {
    const [row] = await this.db.select().from(userTiers).where(eq(userTiers.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Active tiers before deactivated ones — a creator managing their own
   * tiers wants to see what they are currently offering first, with anything
   * turned off pushed to the bottom rather than interleaved by creation date.
   */
  async listByOwner(ownerId: string): Promise<UserTierRow[]> {
    return this.db
      .select()
      .from(userTiers)
      // `community_id IS NULL` is what makes this a PERSONAL listing — see
      // the port. Without it an owner's profile offers memberships to their
      // communities.
      .where(and(eq(userTiers.ownerId, ownerId), isNull(userTiers.communityId)))
      .orderBy(desc(userTiers.isActive), userTiers.createdAt);
  }

  /** Only what this owner is currently offering — what a visitor's profile shows. */
  async listActiveByOwner(ownerId: string): Promise<UserTierRow[]> {
    return this.db
      .select()
      .from(userTiers)
      .where(
        and(
          eq(userTiers.ownerId, ownerId),
          eq(userTiers.isActive, true),
          // Same filter and same reason as `listByOwner` above.
          isNull(userTiers.communityId)
        )
      )
      .orderBy(userTiers.createdAt);
  }

  /**
   * The mirror image: `community_id = $1` where the two personal listings
   * have `community_id IS NULL`. Rides `user_tier_community_idx`, which is
   * partial on non-null so every personal tier stays out of it.
   */
  async listActiveByCommunity(communityId: string): Promise<UserTierRow[]> {
    return this.db
      .select()
      .from(userTiers)
      .where(and(eq(userTiers.communityId, communityId), eq(userTiers.isActive, true)))
      .orderBy(userTiers.createdAt);
  }

  /**
   * Sets `is_active = false` and returns the updated row. Never deletes —
   * see the port's doc comment: a subscription's foreign key to this table
   * must keep resolving after its tier is withdrawn.
   */
  async deactivate(id: string): Promise<UserTierRow | null> {
    const [row] = await this.db
      .update(userTiers)
      .set({ isActive: false })
      .where(eq(userTiers.id, id))
      .returning();
    return row ?? null;
  }
}
