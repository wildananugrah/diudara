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
 * Every lookup is scoped by creatorId on purpose — there is no unscoped
 * findById, so a caller cannot accidentally read another creator's community.
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
}
