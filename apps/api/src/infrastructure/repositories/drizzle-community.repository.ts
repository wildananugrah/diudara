import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, communities, communityMembers } from "../../db/schema";
import { UniqueRule } from "../../application/errors";
import type {
  BrowseCommunitiesQuery,
  CommunityListRow,
  CommunityMemberRow,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../../application/ports/community-repository.port";
import { clampLimit } from "./drizzle-follow.repository";
import { escapeLikePattern } from "./drizzle-user.repository";
import { rethrowUniqueViolation } from "./pg-errors";

/**
 * Every column of `community`. Nothing here is secret — the id is the only
 * value that never crosses the HTTP boundary, and the use-cases strip it —
 * but the columns are listed explicitly anyway, the same discipline the other
 * repositories keep, so a column added later does not silently join every
 * read in this file.
 */
const communityColumns = {
  id: communities.id,
  ownerId: communities.ownerId,
  slug: communities.slug,
  name: communities.name,
  category: communities.category,
  description: communities.description,
  createdAt: communities.createdAt,
} as const;

export class DrizzleCommunityRepository implements CommunityRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * The community and the owner's membership row, in ONE transaction.
   *
   * A community with no members is not a state this app can reach, and the
   * only way to keep that true under a crash between the two inserts is to
   * make them one unit of work. The owner's row carries `role: "owner"`, so
   * the roster can pin them to the top without a second lookup of
   * `community.owner_id`.
   *
   * The slug is derived from a name the caller already validated, but two
   * people naming a community the same thing at the same moment both pass any
   * application-side check — `community_slug_unique` is the only real
   * arbiter, so its violation is translated here rather than escaping into
   * the unhandled-error path, where the driver error's bound parameters ride
   * along.
   */
  async create(input: {
    ownerId: string;
    slug: string;
    name: string;
    category: string;
    description: string | null;
  }): Promise<CommunityRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [community] = await tx
          .insert(communities)
          .values({
            ownerId: input.ownerId,
            slug: input.slug,
            name: input.name,
            category: input.category,
            description: input.description,
          })
          .returning(communityColumns);

        await tx.insert(communityMembers).values({
          communityId: community!.id,
          userId: input.ownerId,
          role: "owner",
        });

        return community!;
      });
    } catch (err) {
      rethrowUniqueViolation(err, {
        community_slug_unique: {
          rule: UniqueRule.communitySlug,
          message: "a community with this name already exists",
        },
      });
    }
  }

  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    const [row] = await this.db
      .select(communityColumns)
      .from(communities)
      .where(eq(communities.slug, slug))
      .limit(1);
    return row ?? null;
  }

  /**
   * One query fills the browse grid, member counts included: a LEFT JOIN onto
   * `community_member` grouped by the community's primary key. LEFT, not
   * INNER — a community can only reach zero members if its owner's row is
   * ever deleted, and a grid that silently drops such a row would hide the
   * bug rather than show a `0`.
   *
   * `search` matches the name case-insensitively and ANYWHERE in it, not just
   * as a prefix the way the people search does: a person types a handle from
   * its start, but recalls a community by a word from the middle of its name.
   * The pattern is escaped first — see `escapeLikePattern`.
   */
  async browse(query: BrowseCommunitiesQuery): Promise<CommunityListRow[]> {
    const filters = [
      query.category === "" ? undefined : eq(communities.category, query.category),
      query.search === ""
        ? undefined
        : ilike(communities.name, `%${escapeLikePattern(query.search)}%`),
    ].filter((f) => f !== undefined);

    return this.db
      .select({
        slug: communities.slug,
        name: communities.name,
        category: communities.category,
        description: communities.description,
        memberCount: count(communityMembers.id),
      })
      .from(communities)
      .leftJoin(communityMembers, eq(communityMembers.communityId, communities.id))
      .where(filters.length === 0 ? undefined : and(...filters))
      // Grouping by the primary key alone is enough: every other selected
      // column of `community` is functionally dependent on it, which Postgres
      // recognises.
      .groupBy(communities.id)
      // id as a tiebreaker, the same reason `listFollowers` gives: two rows
      // can in principle share a `created_at`, and a listing without a total
      // order is not reproducible.
      .orderBy(desc(communities.createdAt), desc(communities.id))
      .limit(clampLimit(query.limit));
  }

  async memberCountFor(communityId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(communityMembers)
      .where(eq(communityMembers.communityId, communityId));
    return row?.value ?? 0;
  }

  async isMember(communityId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: communityMembers.id })
      .from(communityMembers)
      .where(
        and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, userId))
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * `ON CONFLICT ... DO NOTHING` against `community_member_unique`, NOT a bare
   * INSERT wrapped in a try/catch for `23505`: a unique violation aborts the
   * ENCLOSING transaction in Postgres, so catching it here would only be
   * clean when this call happened to be the last statement of its
   * transaction. `DrizzleFollowRepository.follow` carries the full account of
   * that hazard.
   *
   * `target` names the two columns explicitly so a unique constraint added to
   * this table later cannot start silently swallowing an unrelated conflict.
   */
  async join(communityId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .insert(communityMembers)
      .values({ communityId, userId })
      .onConflictDoNothing({
        target: [communityMembers.communityId, communityMembers.userId],
      })
      .returning({ id: communityMembers.id });
    return row !== undefined;
  }

  async leave(communityId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(communityMembers)
      .where(
        and(eq(communityMembers.communityId, communityId), eq(communityMembers.userId, userId))
      )
      .returning({ id: communityMembers.id });
    return rows.length > 0;
  }

  /**
   * The roster: the owner first, then everyone else newest-joined first.
   *
   * The owner is pinned by ordering on the role rather than by a separate
   * query and a concatenation — one statement, and the ordering stays correct
   * if a second privileged role is ever added below `owner`.
   *
   * Projects handle, display name and bio only — the same three public
   * columns `DrizzleFollowRepository.publicListColumns` projects, and never
   * the user's id.
   */
  async listMembers(communityId: string, limit: number): Promise<CommunityMemberRow[]> {
    return this.db
      .select({
        handle: appUsers.handle,
        displayName: appUsers.displayName,
        bio: appUsers.bio,
        role: communityMembers.role,
        joinedAt: communityMembers.joinedAt,
      })
      .from(communityMembers)
      .innerJoin(appUsers, eq(communityMembers.userId, appUsers.id))
      .where(eq(communityMembers.communityId, communityId))
      .orderBy(
        desc(sql`${communityMembers.role} = 'owner'`),
        desc(communityMembers.joinedAt),
        desc(communityMembers.id)
      )
      .limit(clampLimit(limit));
  }
}
