export interface CommunityRecord {
  id: string;
  creatorId: string;
  name: string;
  slug: string;
  niche: string | null;
  status: string;
  createdAt: Date;
}

export interface CommunityPatch {
  name?: string;
  niche?: string;
  slug?: string;
  status?: string;
}

/**
 * Every lookup that returns a record is scoped by creatorId on purpose — there
 * is no unscoped findById, so a caller cannot accidentally read another
 * creator's community. The single deliberate exception is `findBySlug`,
 * documented at its own declaration below: public checkout has no authenticated
 * caller to scope by. (`slugExists` is unscoped too, but it answers only
 * yes/no and returns no data, so it leaks nothing about another creator.)
 */
export interface CommunityRepositoryPort {
  create(input: {
    creatorId: string;
    name: string;
    slug: string;
    niche?: string;
  }): Promise<CommunityRecord>;
  findByIdForCreator(id: string, creatorId: string): Promise<CommunityRecord | null>;
  listByCreator(creatorId: string): Promise<CommunityRecord[]>;
  slugExists(slug: string): Promise<boolean>;
  update(id: string, creatorId: string, patch: CommunityPatch): Promise<CommunityRecord | null>;
  /**
   * Unscoped by creator ON PURPOSE — the public checkout page has no
   * authenticated caller. This is the only unscoped method that returns a
   * record; `slugExists` is also unscoped but returns only a boolean. Never
   * use this to serve an authenticated route.
   */
  findBySlug(slug: string): Promise<CommunityRecord | null>;
}
