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
  /**
   * In order. `position` is the index in `ids`. Rows previously on this post and
   * absent from `ids` are UNCLAIMED, not deleted.
   *
   * **RETURNS HOW MANY ROWS IT ACTUALLY CLAIMED, and a caller that asked for N
   * and got fewer has lost a race it must not ignore.** Final whole-branch
   * review, Important 4: this used to return nothing and issue one blind UPDATE
   * per id, so an id the sweep had deleted in the moment between the ownership
   * check and this call was a NO-OP — the post came back holding fewer photos
   * than its author sent, and nothing anywhere said so.
   */
  claim(postId: string, ids: string[]): Promise<number>;
  listForPost(postId: string): Promise<MediaRow[]>;
  listForPosts(postIds: string[]): Promise<MediaRow[]>;
  listUnclaimedBefore(cutoff: Date, limit: number): Promise<MediaRow[]>;
  /**
   * Deletes the row ONLY while it is still unclaimed, answering whether it did.
   *
   * **The guard is the point, and it is why this is not `deleteById`.** The
   * sweep lists unclaimed rows and then deletes them one at a time; a row
   * claimed by a post in between (a composer left open overnight, then used)
   * would otherwise lose its row and its bytes, and the post would silently
   * hold fewer photos than its author sent. `false` means "not mine to delete"
   * — either it was claimed, or it is already gone — and the caller must treat
   * it as a skip, never as a failure to retry.
   */
  deleteIfUnclaimed(id: string): Promise<boolean>;
}
