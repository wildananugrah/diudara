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
  create(input: {
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
