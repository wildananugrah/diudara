import { and, desc, eq } from "drizzle-orm";
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
  }): Promise<UserTierRow> {
    const [row] = await this.db
      .insert(userTiers)
      .values({
        ownerId: input.ownerId,
        name: input.name,
        priceAmount: input.priceAmount,
        billingCycle: input.billingCycle,
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
      .where(eq(userTiers.ownerId, ownerId))
      .orderBy(desc(userTiers.isActive), userTiers.createdAt);
  }

  /** Only what this owner is currently offering — what a visitor's profile shows. */
  async listActiveByOwner(ownerId: string): Promise<UserTierRow[]> {
    return this.db
      .select()
      .from(userTiers)
      .where(and(eq(userTiers.ownerId, ownerId), eq(userTiers.isActive, true)))
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
