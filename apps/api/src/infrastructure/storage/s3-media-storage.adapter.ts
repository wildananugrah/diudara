import { S3Client } from "bun";
import type { MediaObject, MediaStoragePort } from "../../application/ports/media-storage.port";

/**
 * !!! UNVERIFIED AGAINST A LIVE BUCKET !!!
 *
 * Written against Bun's own `S3Client` documentation with no Biznet Gio NEO
 * credentials anywhere in this repository's history to test one against —
 * see the task-2 report for what "deliberately thin" bought instead: a class
 * short enough to read for correctness, three calls straight through to
 * `Bun.S3Client`/`S3File` with no logic of its own to get wrong. Exercise it
 * against a real bucket (Task 4's upload pipeline is the first real caller)
 * before trusting a creator's photo to it, then delete this warning.
 *
 * Biznet Gio NEO Object Storage, or any S3-compatible bucket. Bun ships the
 * client, so this adds no dependency.
 *
 * The key layout lives HERE and nowhere else. Nothing outside this file knows
 * that media is stored as `posts/<id>/full.webp` — the port takes an id and a
 * variant — which is what makes a bucket URL structurally unable to escape into
 * a response (spec §5.1).
 */
export class S3MediaStorageAdapter implements MediaStoragePort {
  private readonly client: S3Client;

  constructor(config: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint: string;
    region: string;
  }) {
    this.client = new S3Client(config);
  }

  private key(id: string, variant: "full" | "thumb"): string {
    return `posts/${id}/${variant}.webp`;
  }

  async put(id: string, variant: "full" | "thumb", bytes: Uint8Array): Promise<void> {
    await this.client.write(this.key(id, variant), bytes, { type: "image/webp" });
  }

  async get(id: string, variant: "full" | "thumb"): Promise<MediaObject | null> {
    const file = this.client.file(this.key(id, variant));
    if (!(await file.exists())) return null;
    return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: "image/webp" };
  }

  async remove(id: string): Promise<void> {
    // Both variants, and absent objects are not an error.
    await Promise.all([
      this.client.file(this.key(id, "full")).delete().catch(() => {}),
      this.client.file(this.key(id, "thumb")).delete().catch(() => {}),
    ]);
  }
}
