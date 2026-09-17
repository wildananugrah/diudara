import { and, eq, ilike, or, sql, gte, count } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { communities, communityMembers, liveSessions, trendingTags } from "../db/schema.ts";
import type { CommunityListItem, CommunityRepository } from "../../domain/ports.ts";
import { VIEWER_PRESENCE_WINDOW_SECONDS } from "../../domain/livePresence.ts";

export class DrizzleCommunityRepository implements CommunityRepository {
  constructor(private readonly db: Db) {}

  /**
   * One query with correlated subselects — avoids an N+1 over member counts.
   *
   * The subqueries are written with explicit table ALIASES (cm/ls) rather than
   * Drizzle column interpolation. Interpolating `${liveSessions.communityId}`
   * renders an UNQUALIFIED `"community_id"`, and the correlating
   * `${communities.id}` renders an unqualified `"id"` — which, inside a subquery
   * whose FROM table has its own `id` column, silently binds to the INNER table.
   * That made `live_count` compare live_sessions.community_id = live_sessions.id,
   * so isLive was always false. Aliasing makes the correlation explicit.
   * These identifiers are static, so no user input reaches the raw SQL.
   */
  private baseQuery() {
    const memberCount = sql<number>`(
      SELECT COUNT(*)::int FROM community_members cm
      WHERE cm.community_id = communities.id AND cm.status = 'active'
    )`.as("member_count");

    const live = sql<number>`(
      SELECT COUNT(*)::int FROM live_sessions ls
      WHERE ls.community_id = communities.id AND ls.status = 'live'
    )`.as("live_count");

    // Real people, not a stored number: members whose player checked in within
    // the presence window. `live_sessions.viewer_count` is gone — it was seeded
    // at 128 and nothing ever moved it.
    const liveViewers = sql<number>`(
      SELECT COUNT(*)::int FROM live_viewers lv
      JOIN live_sessions ls ON ls.id = lv.session_id
      WHERE ls.community_id = communities.id AND ls.status = 'live'
        AND lv.last_seen_at >= NOW() - make_interval(secs => ${VIEWER_PRESENCE_WINDOW_SECONDS})
    )`.as("live_viewers");

    // "trending" has no source in the mock (SPEC.md §6.5). Rule chosen: 20+ new
    // active members in the last 7 days. Stated here rather than invented silently.
    const trending = sql<boolean>`(
      SELECT COUNT(*) >= 20 FROM community_members cm
      WHERE cm.community_id = communities.id AND cm.status = 'active'
        AND cm.joined_at >= NOW() - INTERVAL '7 days'
    )`.as("trending");

    return this.db.select({
      id: communities.id, name: communities.name, niche: communities.niche,
      category: communities.category, description: communities.description,
      color: communities.color, priceCents: communities.priceCents,
      billingPeriod: communities.billingPeriod, ownerId: communities.ownerId,
      memberCount, live, liveViewers, trending,
    }).from(communities);
  }

  private static map(r: Awaited<ReturnType<DrizzleCommunityRepository["baseQuery"]>>[number]): CommunityListItem {
    const { live, ...rest } = r;
    return { ...rest, isLive: live > 0, trending: Boolean(r.trending) };
  }

  async list(filter: { q?: string; category?: string; isLive?: boolean }): Promise<CommunityListItem[]> {
    const conditions = [];
    if (filter.q) {
      // Matches name OR niche — same rule Discover.tsx uses client-side.
      conditions.push(or(ilike(communities.name, `%${filter.q}%`), ilike(communities.niche, `%${filter.q}%`)));
    }
    if (filter.category && filter.category !== "Semua") {
      conditions.push(eq(communities.category, filter.category));
    }

    const rows = await this.baseQuery().where(conditions.length ? and(...conditions) : undefined);
    const mapped = rows.map(DrizzleCommunityRepository.map);
    return filter.isLive ? mapped.filter((c) => c.isLive) : mapped;
  }

  async findById(id: string): Promise<CommunityListItem | null> {
    const [row] = await this.baseQuery().where(eq(communities.id, id)).limit(1);
    return row ? DrizzleCommunityRepository.map(row) : null;
  }

  async listCategories(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ category: communities.category })
      .from(communities)
      .orderBy(communities.category);
    return ["Semua", ...rows.map((r) => r.category)];
  }

  async listTrendingTags(): Promise<string[]> {
    const rows = await this.db.select().from(trendingTags).orderBy(trendingTags.sortOrder);
    return rows.map((r) => r.tag);
  }

  async exists(id: string): Promise<boolean> {
    const [row] = await this.db.select({ id: communities.id })
      .from(communities).where(eq(communities.id, id)).limit(1);
    return Boolean(row);
  }

  async create(input: {
    id: string; name: string; niche: string; category: string; description: string;
    color: string; priceCents: number; billingPeriod: string; ownerId: string;
  }): Promise<CommunityListItem> {
    await this.db.insert(communities).values(input);
    // Re-read through baseQuery so the caller gets the same shape (memberCount,
    // isLive, trending) every other endpoint returns, rather than a second
    // hand-rolled mapping that could drift from it.
    const created = await this.findById(input.id);
    if (!created) throw new Error(`Community ${input.id} vanished immediately after insert`);
    return created;
  }
}
