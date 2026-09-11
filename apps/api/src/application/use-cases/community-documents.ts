import {
  DOCUMENT_ERROR_CODE,
  MAX_DOCUMENT_BYTES,
  isAllowedDocumentType,
} from "@diudara/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { sanitiseDocumentName } from "../../domain/document";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { DocumentRepositoryPort, DocumentRow } from "../ports/document-repository.port";
import type { DocumentStoragePort } from "../ports/document-storage.port";

/**
 * One document as the wire sees it. Nested HERE, the one place this projection
 * is assembled, exactly as `toPostView` and `toEventView` are.
 *
 * **No URL, and no bucket key.** The id IS the identifier; the download path
 * is derived from it and the slug by the client. That is the rule `MediaView`
 * records, and it is what keeps a bucket URL structurally unable to reach a
 * response.
 */
export interface CommunityDocumentView {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  /** ISO-8601. */
  createdAt: string;
  uploader: { handle: string; displayName: string };
}

export interface CommunityDocumentsPage {
  documents: CommunityDocumentView[];
  /**
   * Whether THIS viewer may fetch bytes. On the page rather than left to the
   * client to infer from a membership flag it would have to fetch separately:
   * a download control must never be rendered for an action that would fail,
   * the rule Phase 1 set when it cut the tab bar.
   */
  viewerMayDownload: boolean;
}

function toDocumentView(row: DocumentRow): CommunityDocumentView {
  return {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    uploader: { handle: row.uploaderHandle, displayName: row.uploaderDisplayName },
  };
}

/**
 * `POST /communities/:slug/documents` — the owner adds a file.
 *
 * **Every refusal happens before anything is written**, and the tests assert
 * that against the STORAGE, not the status code: there is no sweep over
 * `community_document` the way the worker collects unclaimed `post_media`, so
 * an orphan object here is an orphan forever.
 *
 * ORDER MATTERS, the same order `UploadMedia` uses and for the same reason:
 * the id is generated here, the bytes land under it, and only then does the
 * row that makes the id discoverable exist. A reader can never reach a row
 * whose bytes are still being written. The compensating `remove` below is what
 * keeps the converse true.
 */
export class UploadCommunityDocument {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly documents: DocumentRepositoryPort,
    private readonly storage: DocumentStoragePort
  ) {}

  async execute(input: {
    slug: string;
    uploaderId: string;
    name: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<CommunityDocumentView> {
    // The slug resolves FIRST, before the owner check, so an unknown slug is
    // always a 404 and never a 403 — a 403 on a slug that does not exist
    // confirms to a probe which slugs do.
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");
    if (community.ownerId !== input.uploaderId) {
      throw new ForbiddenError("hanya pemilik komunitas yang boleh mengunggah dokumen");
    }

    // SIZE, then NAME, then TYPE — and the middle two are in that order for a
    // measured reason, not a stylistic one. A file whose name has no extension
    // arrives from a multipart body with an EMPTY `Content-Type`: the browser
    // (and Bun) derive the part's type from the extension, so a nameless file
    // fails the type check too. Checking the type first answered "format not
    // supported" for a file whose actual problem was its name, which is the
    // less accurate of the two diagnoses and the harder one to act on.
    //
    // None of the three touches storage, so every refusal here leaves nothing
    // behind.
    if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new ValidationError("ukuran berkas melebihi batas", DOCUMENT_ERROR_CODE.tooLarge);
    }
    // Throws `DocumentRejectedError`, which the route turns into a 400 with
    // the domain's own code — the shape `ImageRejectedError` established.
    const name = sanitiseDocumentName(input.name);
    if (!isAllowedDocumentType(input.contentType)) {
      throw new ValidationError("format berkas tidak didukung", DOCUMENT_ERROR_CODE.unsupportedFormat);
    }

    const id = crypto.randomUUID();
    await this.storage.put(id, input.bytes);

    let row: DocumentRow;
    try {
      row = await this.documents.create({
        id,
        communityId: community.id,
        uploaderId: input.uploaderId,
        name,
        // STORED as declared, and untrusted as a claim about the bytes. The
        // three measures that make that safe live on the delivery route and
        // in the allowlist above — see the spec's "The security decision".
        contentType: input.contentType,
        // MEASURED, never taken from the caller. A client-supplied size is a
        // number that can disagree with what is in the bucket.
        byteSize: input.bytes.byteLength,
      });
    } catch (error) {
      // Take the bytes back. Without this, every failed insert leaves an
      // object nobody can reach and nothing will collect. Best-effort: the
      // original failure is what the caller needs to see, so a failing cleanup
      // must not replace it.
      await this.storage.remove(id).catch(() => {});
      throw error;
    }

    return toDocumentView(row);
  }
}

/**
 * `GET /communities/:slug/documents` — OPEN.
 *
 * A non-member sees names, sizes and dates, which is enough to judge whether a
 * community is worth joining — Phase 1's whole argument for open reading. The
 * bytes are a separate decision, made by `DownloadCommunityDocument`.
 */
export class ListCommunityDocuments {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly documents: DocumentRepositoryPort
  ) {}

  async execute(input: { slug: string; viewerId: string | null }): Promise<CommunityDocumentsPage> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("komunitas tidak ditemukan");

    const rows = await this.documents.listByCommunity(community.id);
    return {
      documents: rows.map(toDocumentView),
      // A signed-out viewer is never a member and is not asked about — the
      // repository is not consulted for a `null` id.
      viewerMayDownload:
        input.viewerId !== null && (await this.communities.isMember(community.id, input.viewerId)),
    };
  }
}

/**
 * `GET /communities/:slug/documents/:id` — MEMBER-GATED, and the first gated
 * surface in the programme.
 *
 * **Every refusal is a `NotFoundError`, never `ForbiddenError`.** The rule
 * `routes/media.ts` already applies to gated media: a 403 confirms the
 * document exists to somebody who may not have it, and an absent document
 * already answers 404, so gated and absent look identical from outside.
 *
 * The slug is checked against the row's own `communityId`, not merely used to
 * find the community. A document reachable through any slug would let a member
 * of one community read another's library.
 */
export class DownloadCommunityDocument {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly documents: DocumentRepositoryPort,
    private readonly storage: DocumentStoragePort
  ) {}

  async execute(input: {
    slug: string;
    id: string;
    viewerId: string | null;
  }): Promise<{ bytes: Uint8Array; contentType: string; name: string }> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("dokumen tidak ditemukan");

    const row = await this.documents.findById(input.id);
    // Absent, deleted, or belonging to a different community — one answer for
    // all three, so none of them is distinguishable by probing.
    if (row === null || row.communityId !== community.id) {
      throw new NotFoundError("dokumen tidak ditemukan");
    }

    if (
      input.viewerId === null ||
      !(await this.communities.isMember(community.id, input.viewerId))
    ) {
      throw new NotFoundError("dokumen tidak ditemukan");
    }

    const bytes = await this.storage.get(row.id);
    // A row with no bytes behind it (an interrupted upload, manual bucket
    // interference) is absence from the caller's point of view — 404, never a
    // 500 from dereferencing null. The rule `routes/media.ts` records.
    if (bytes === null) throw new NotFoundError("dokumen tidak ditemukan");

    return { bytes, contentType: row.contentType, name: row.name };
  }
}

/**
 * `DELETE /communities/:slug/documents/:id` — the owner's alone.
 *
 * Removes the BYTES as well as soft-deleting the row. A post's images are
 * deliberately retained after a delete (`media-entitlement.ts` records why);
 * a document has exactly one referent and no second surface that might still
 * want it, so keeping the object would only be paying to store something
 * unreachable.
 *
 * The row is soft-deleted FIRST. If the bucket delete then fails the document
 * is already gone from every read path, which is the state the caller asked
 * for; the reverse order could leave a live row pointing at bytes that no
 * longer exist.
 */
export class DeleteCommunityDocument {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly documents: DocumentRepositoryPort,
    private readonly storage: DocumentStoragePort
  ) {}

  async execute(input: { slug: string; id: string; viewerId: string }): Promise<{ deleted: true }> {
    const community = await this.communities.findBySlug(input.slug);
    if (community === null) throw new NotFoundError("dokumen tidak ditemukan");

    const row = await this.documents.findById(input.id);
    if (row === null || row.communityId !== community.id) {
      throw new NotFoundError("dokumen tidak ditemukan");
    }
    // AFTER the row resolves, so a non-owner probing ids cannot tell an
    // existing document from an absent one by which error comes back.
    if (community.ownerId !== input.viewerId) {
      throw new ForbiddenError("hanya pemilik komunitas yang boleh menghapus dokumen");
    }

    await this.documents.softDelete(row.id);
    await this.storage.remove(row.id);
    return { deleted: true };
  }
}
