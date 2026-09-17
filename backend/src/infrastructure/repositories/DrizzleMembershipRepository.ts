import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { communityMembers, users } from "../db/schema.ts";
import type { MembershipRepository } from "../../domain/ports.ts";
import type { MemberRole, MemberStatus, Membership } from "../../domain/types.ts";

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Db) {}

  async find(communityId: string, userId: string): Promise<Membership | null> {
    const [row] = await this.db.select().from(communityMembers)
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, userId)))
      .limit(1);
    return row
      ? { communityId: row.communityId, userId: row.userId, role: row.role, status: row.status, tierId: row.tierId, joinedAt: row.joinedAt }
      : null;
  }

  async listMembers(communityId: string) {
    return this.db.select({
      userId: communityMembers.userId,
      name: users.name,
      role: communityMembers.role,
      status: communityMembers.status,
      joinedAt: communityMembers.joinedAt,
      endedAt: communityMembers.endedAt,
    })
      .from(communityMembers)
      .innerJoin(users, eq(users.id, communityMembers.userId))
      .where(eq(communityMembers.communityId, communityId))
      .orderBy(communityMembers.joinedAt);
  }

  async listForUser(userId: string) {
    return this.db.select({
      communityId: communityMembers.communityId,
      role: communityMembers.role,
      status: communityMembers.status,
    }).from(communityMembers).where(eq(communityMembers.userId, userId));
  }

  async markChurned(communityId: string, userId: string): Promise<void> {
    await this.db.update(communityMembers)
      .set({ status: "churned", endedAt: new Date() })
      .where(and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, userId)));
  }

  async upsert(input: {
    communityId: string; userId: string; role: MemberRole;
    status: MemberStatus; tierId: string | null;
  }): Promise<Membership> {
    const [row] = await this.db.insert(communityMembers)
      .values(input)
      .onConflictDoUpdate({
        target: [communityMembers.communityId, communityMembers.userId],
        // Role is deliberately NOT overwritten: re-subscribing must never silently
        // demote an owner/admin back to plain member.
        set: { status: input.status, tierId: input.tierId, endedAt: null },
      })
      .returning();
    return {
      communityId: row!.communityId, userId: row!.userId, role: row!.role,
      status: row!.status, tierId: row!.tierId, joinedAt: row!.joinedAt,
    };
  }
}
