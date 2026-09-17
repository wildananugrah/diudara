import type { DocumentRepository, FileStorage, UploadRepository } from "../domain/ports.ts";
import type { UploadKind } from "../domain/types.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import type { AccessPolicy } from "./AccessPolicy.ts";

const MAX_BYTES = 64 * 1024 * 1024; // matches nginx client_max_body_size 64M

function kindOf(mime: string): UploadKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * documents.type is the library's own vocabulary — "document" | "video" | "file"
 * — which the Dokumen tab maps to icons. It is narrower than UploadKind, so a
 * readable document collapses to "document" and everything else to "file".
 */
export function libraryTypeOf(mime: string, kind: UploadKind): string {
  if (kind === "video") return "video";
  if (/^(application\/pdf|application\/epub|text\/)/.test(mime)) return "document";
  if (/(word|spreadsheet|presentation|officedocument|opendocument)/.test(mime)) return "document";
  return "file";
}

export class UploadService {
  constructor(
    private readonly uploads: UploadRepository,
    private readonly storage: FileStorage,
    private readonly documents: DocumentRepository,
    private readonly access: AccessPolicy,
  ) {}

  async upload(userId: string, file: File) {
    if (!file || file.size === 0) throw new ValidationError("File kosong");
    // Checked before touching disk so an oversized upload cannot fill the volume.
    if (file.size > MAX_BYTES) throw new ValidationError("Ukuran file melebihi 64MB");

    const { storageKey, sizeBytes } = await this.storage.save(file);
    return this.uploads.create({
      uploaderId: userId,
      filename: file.name || "untitled",
      mime: file.type || "application/octet-stream",
      sizeBytes,
      storageKey,
      kind: kindOf(file.type || ""),
    });
  }

  /**
   * Publishes an already-uploaded file into a community's document library.
   * Admin-only, and the metadata is read from the upload rather than trusted
   * from the client — otherwise a caller could claim any name or size.
   */
  async addDocument(communityId: string, userId: string, input: { uploadId: string; name?: string }) {
    await this.access.requireAdmin(communityId, userId);

    const upload = await this.uploads.findById(input.uploadId);
    // 422 rather than letting the bad id hit the FK and surface as a 500.
    if (!upload) throw new ValidationError(`Lampiran tidak ditemukan: ${input.uploadId}`);

    return this.documents.create({
      communityId,
      uploadId: upload.id,
      name: input.name?.trim() || upload.filename,
      type: libraryTypeOf(upload.mime, upload.kind),
      sizeBytes: upload.sizeBytes,
    });
  }

  /**
   * Removes a document from the library. The underlying upload is deliberately
   * left on disk: other rows (a materi item, a post attachment) may point at the
   * same file, so deleting it here could break them.
   */
  async removeDocument(documentId: string, userId: string) {
    const doc = await this.documents.findById(documentId);
    if (!doc) throw new NotFoundError("Dokumen");
    await this.access.requireAdmin(doc.communityId, userId);
    await this.documents.delete(documentId);
    return { ok: true };
  }

  async streamUpload(uploadId: string) {
    const upload = await this.uploads.findById(uploadId);
    if (!upload) throw new NotFoundError("File");
    const stream = await this.storage.read(upload.storageKey);
    if (!stream) throw new NotFoundError("File");
    return { stream, mime: upload.mime, filename: upload.filename };
  }

  /** Download is gated on membership AND records the event, which is what makes
   *  the dashboard's topDocuments figure real rather than invented. */
  async downloadDocument(documentId: string, userId: string) {
    const doc = await this.documents.findById(documentId);
    if (!doc) throw new NotFoundError("Dokumen");
    await this.access.requireMember(doc.communityId, userId);

    const stream = await this.storage.read(doc.storageKey);
    if (!stream) throw new NotFoundError("Berkas dokumen");

    await this.documents.recordDownload(documentId, userId);
    return { stream, mime: doc.mime, filename: doc.name };
  }
}
