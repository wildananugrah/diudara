import type { StreamViewerRepositoryPort } from "../ports/stream-viewer-repository.port";

/**
 * A thin pass-through — routes call a use-case rather than a repository
 * directly (see `EndUserStream` for the pattern this mirrors), even though
 * there is no decision to make here: the identity to record was already
 * decided by `AuthoriseStream`, and validating a stream still exists would
 * be a second lookup the caller already paid for by resolving it to answer
 * `allowed: true` in the first place.
 */
export class RecordStreamViewerHeartbeat {
  constructor(private readonly streamViewers: StreamViewerRepositoryPort) {}

  async execute(input: { streamId: string; identity: string; now: Date }): Promise<void> {
    await this.streamViewers.heartbeat(input.streamId, input.identity, input.now);
  }
}
