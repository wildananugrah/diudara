import { and, eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { membershipTiers } from "../../db/schema";
import type {
  MembershipTierRepositoryPort,
  TierPatch,
  TierRecord,
} from "../../application/ports/membership-tier-repository.port";

export class DrizzleMembershipTierRepository implements MembershipTierRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    communityId: string;
    name: string;
    priceAmount: number;
    billingCycle: string;
  }): Promise<TierRecord> {
    const [row] = await this.db.insert(membershipTiers).values(input).returning();
    return row;
  }

  async listByCommunity(communityId: string): Promise<TierRecord[]> {
    return this.db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.communityId, communityId));
  }

  async updateForCommunity(
    tierId: string,
    communityId: string,
    patch: TierPatch
  ): Promise<TierRecord | null> {
    const [row] = await this.db
      .update(membershipTiers)
      .set(patch)
      .where(and(eq(membershipTiers.id, tierId), eq(membershipTiers.communityId, communityId)))
      .returning();
    return row ?? null;
  }
}
