import { ValidationError } from "../errors";
import { MAX_UPLOAD_BYTES, processUpload } from "../../domain/image";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { MediaStoragePort } from "../ports/media-storage.port";

const TOO_LARGE_MESSAGE = `Ukuran foto maksimal ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`;

/** `POST /users/media`'s decision logic. */
export class UploadMedia {
  constructor(
    private readonly media: MediaRepositoryPort,
    private readonly storage: MediaStoragePort
  ) {}

  async execute(input: {
    ownerId: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; width: number; height: number }> {
    // Checked BEFORE `processUpload` runs: an oversized upload must be
    // refused without ever being handed to sharp.
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ValidationError(TOO_LARGE_MESSAGE);
    }

    // `UnsupportedImageError` propagates from here unchanged — the route is
    // what turns it into a 400, this class never swallows it.
    const processed = await processUpload(input.bytes);

    // Generated HERE, not left to the row's own default, because both
    // variants have to land in the bucket under this id BEFORE the row that
    // makes the id discoverable exists — see `MediaRepositoryPort.create`'s
    // `id` field for why that order matters and what it costs to get wrong.
    const id = crypto.randomUUID();
    await this.storage.put(id, "full", processed.full);
    await this.storage.put(id, "thumb", processed.thumb);

    const row = await this.media.create({
      id,
      ownerId: input.ownerId,
      width: processed.width,
      height: processed.height,
      byteSize: processed.full.byteLength,
    });

    return { id: row.id, width: row.width, height: row.height };
  }
}
