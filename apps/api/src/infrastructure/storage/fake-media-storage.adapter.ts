import type { MediaObject, MediaStoragePort } from "../../application/ports/media-storage.port";

/**
 * In-memory media storage for tests and local development — the same role
 * `FakePaymentAdapter`/`FakeMessagingAdapter` play for their ports. Keeps
 * both variants of every image in one `Map`, keyed on `${id}:${variant}`, so
 * a `full` and a `thumb` for the same id never collide.
 *
 * `contentType` is hardcoded to `"image/webp"` because every byte this
 * process ever stores has already been transcoded to webp before it reaches
 * `put` — Task 4's upload pipeline, not this adapter, owns that conversion.
 */
export class FakeMediaStorageAdapter implements MediaStoragePort {
  private readonly objects = new Map<string, Uint8Array>();

  /** Exposed so a test can assert nothing leaked after a `remove`. */
  get size(): number {
    return this.objects.size;
  }

  private key(id: string, variant: "full" | "thumb"): string {
    return `${id}:${variant}`;
  }

  async put(id: string, variant: "full" | "thumb", bytes: Uint8Array): Promise<void> {
    this.objects.set(this.key(id, variant), bytes);
  }

  async get(id: string, variant: "full" | "thumb"): Promise<MediaObject | null> {
    const bytes = this.objects.get(this.key(id, variant));
    if (bytes === undefined) return null;
    return { bytes, contentType: "image/webp" };
  }

  async remove(id: string): Promise<void> {
    this.objects.delete(this.key(id, "full"));
    this.objects.delete(this.key(id, "thumb"));
  }
}
