import type { DocumentStoragePort } from "../../application/ports/document-storage.port";

/**
 * In-memory document storage for tests and local development — the role
 * `FakeMediaStorageAdapter` plays for its own port.
 *
 * Keyed on the id alone: a document has one object, unlike an image's two
 * variants, so there is no composite key and nothing to collide.
 */
export class FakeDocumentStorageAdapter implements DocumentStoragePort {
  private readonly objects = new Map<string, Uint8Array>();

  /**
   * Exposed so a test can assert nothing leaked — both after a `remove`, and
   * after a REFUSED upload, which must leave no orphan behind. Nothing sweeps
   * this table the way the media sweep collects unclaimed `post_media`.
   */
  get size(): number {
    return this.objects.size;
  }

  /** Exposed so a test can assert the stored bytes are the ones that arrived. */
  peek(id: string): Uint8Array | undefined {
    return this.objects.get(id);
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(id, bytes);
  }

  async get(id: string): Promise<Uint8Array | null> {
    return this.objects.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.objects.delete(id);
  }
}
