import { and, desc, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../../db/client";
import { appUsers, communityDocuments } from "../../db/schema";
import type {
  DocumentRepositoryPort,
  DocumentRow,
} from "../../application/ports/document-repository.port";

/**
 * The ONE projection every read path selects. `deleted_at` is absent by
 * construction rather than stripped later — the rule
 * `drizzle-post.repository.ts` records after a review found an invariant
 * defended on only two of five paths because each chose its own columns.
 */
const documentColumns = {
  id: communityDocuments.id,
  communityId: communityDocuments.communityId,
  name: communityDocuments.name,
  contentType: communityDocuments.contentType,
  byteSize: communityDocuments.byteSize,
  createdAt: communityDocuments.createdAt,
  uploaderHandle: appUsers.handle,
  uploaderDisplayName: appUsers.displayName,
} as const;

export class DrizzleDocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly db: DatabaseExecutor) {}

  async create(input: {
    id: string;
    communityId: string;
    uploaderId: string;
    name: string;
    contentType: string;
    byteSize: number;
  }): Promise<DocumentRow> {
    const [inserted] = await this.db
      .insert(communityDocuments)
      .values(input)
      .returning({ id: communityDocuments.id });
    const row = await this.findById(inserted!.id);
    // Just inserted inside this call; a null here means the projection join is
    // broken, which is a bug rather than a missing document.
    if (row === null) throw new Error("document disappeared immediately after insert");
    return row;
  }

  /**
   * Newest first, matching `community_document_community_created_idx`'s own
   * `created_at desc` declaration so the order is served by the scan.
   *
   * `desc()` here is drizzle's query-builder helper, which emits a bare `DESC`
   * that Postgres reads as `NULLS FIRST` — harmless on this index, unlike on
   * `post`'s, because `created_at` is `NOT NULL` and this index carries no
   * explicit NULLS placement to mismatch. `drizzle-post.repository.ts`'s
   * `newestFirstOrder()` explains the case where it is NOT harmless.
   */
  listByCommunity(communityId: string): Promise<DocumentRow[]> {
    return this.db
      .select(documentColumns)
      .from(communityDocuments)
      .innerJoin(appUsers, eq(appUsers.id, communityDocuments.uploaderId))
      .where(
        and(
          eq(communityDocuments.communityId, communityId),
          isNull(communityDocuments.deletedAt)
        )
      )
      .orderBy(desc(communityDocuments.createdAt));
  }

  async findById(id: string): Promise<DocumentRow | null> {
    const [row] = await this.db
      .select(documentColumns)
      .from(communityDocuments)
      .innerJoin(appUsers, eq(appUsers.id, communityDocuments.uploaderId))
      .where(and(eq(communityDocuments.id, id), isNull(communityDocuments.deletedAt)));
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(communityDocuments)
      .set({ deletedAt: new Date() })
      // `deleted_at IS NULL` in the predicate, so a second delete touches no
      // row rather than moving the timestamp — idempotent in the sense the
      // port promises, and it keeps the ORIGINAL deletion time.
      .where(and(eq(communityDocuments.id, id), isNull(communityDocuments.deletedAt)));
  }
}
