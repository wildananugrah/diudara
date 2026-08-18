/** One media row. `postId` is null while the row is unclaimed — see the schema. */
export interface MediaRow {
  id: string;
  ownerId: string;
  postId: string | null;
  position: number;
  width: number;
  height: number;
  byteSize: number;
  createdAt: Date;
}

export interface MediaRepositoryPort {
  /**
   * `id` is OPTIONAL and exists for exactly one caller: Task 4's `UploadMedia`,
   * which must write both variants to `MediaStoragePort` under a media id
   * BEFORE this row exists — an interrupted upload then leaves at worst an
   * unreferenced object (spec §8), where a row created before its bytes land
   * would leave an id that 404s forever. That ordering only works if the same
   * id backs the storage keys and the row, so the caller generates it and
   * passes it through here rather than letting the column's own default
   * assign one after the fact. Omitted, the column's default applies exactly
   * as before — every other caller in this codebase omits it.
   */
  create(input: {
    id?: string;
    ownerId: string;
    width: number;
    height: number;
    byteSize: number;
  }): Promise<MediaRow>;
  findById(id: string): Promise<MediaRow | null>;
  findManyByIds(ids: string[]): Promise<MediaRow[]>;
  /** In order. `position` is the index in `ids`. Rows previously on this post and absent from `ids` are UNCLAIMED, not deleted. */
  claim(postId: string, ids: string[]): Promise<void>;
  listForPost(postId: string): Promise<MediaRow[]>;
  listForPosts(postIds: string[]): Promise<MediaRow[]>;
  listUnclaimedBefore(cutoff: Date, limit: number): Promise<MediaRow[]>;
  deleteById(id: string): Promise<void>;
}
