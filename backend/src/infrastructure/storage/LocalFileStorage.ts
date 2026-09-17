import { mkdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import type { FileStorage } from "../../domain/ports.ts";

/**
 * Disk-backed storage. Swapping to S3 means writing an S3FileStorage with the
 * same three methods — no service changes (OCP).
 */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async save(file: File): Promise<{ storageKey: string; sizeBytes: number }> {
    // Extension is derived from the original name but the stored filename is a
    // fresh UUID: the client-supplied name never reaches the filesystem, so it
    // cannot contain path separators or traversal sequences.
    const ext = extname(file.name).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, "");
    const storageKey = `${crypto.randomUUID()}${ext}`;
    await mkdir(this.root, { recursive: true });
    const bytes = await file.arrayBuffer();
    await Bun.write(join(this.root, storageKey), bytes);
    return { storageKey, sizeBytes: bytes.byteLength };
  }

  async read(storageKey: string): Promise<ReadableStream | null> {
    // Defence in depth: keys are UUIDs we generated, but a corrupted DB row must
    // not be able to read outside the storage root.
    const full = resolve(this.root, storageKey);
    if (!full.startsWith(this.root)) return null;
    const file = Bun.file(full);
    return (await file.exists()) ? file.stream() : null;
  }

  urlFor(uploadId: string): string {
    return `/api/uploads/${uploadId}`;
  }
}
