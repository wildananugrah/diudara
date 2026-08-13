import { ConflictError, NotFoundError } from "../errors";
import type {
  CommunityPatch,
  CommunityRecord,
  CommunityRepositoryPort,
} from "../ports/community-repository.port";

export interface UpdateCommunityOptions {
  /**
   * Whether this process has a real payment path — `payments !== null` from
   * `selectPaymentProvider` (see bootstrap.ts). Defaults to `true`, mirroring
   * `CreateCommunityOptions`, so every existing caller/test keeps its old,
   * unguarded behaviour.
   */
  paymentsEnabled?: boolean;
}

export class UpdateCommunity {
  private readonly paymentsEnabled: boolean;

  constructor(
    private readonly communities: CommunityRepositoryPort,
    options: UpdateCommunityOptions = {}
  ) {
    this.paymentsEnabled = options.paymentsEnabled ?? true;
  }

  async execute(input: {
    communityId: string;
    creatorId: string;
    patch: CommunityPatch;
  }): Promise<CommunityRecord> {
    const existing = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!existing) {
      throw new NotFoundError("community not found");
    }

    // Unlike `CreateCommunity`, an OMITTED `accessMode` here means "leave it
    // as it is" — ordinary patch semantics — so only an EXPLICIT "paid" is
    // guarded. A community already sitting at `paid` that this patch never
    // touches is not this use-case's problem to re-validate.
    if (!this.paymentsEnabled && input.patch.accessMode === "paid") {
      throw new ConflictError(
        "pembayaran belum dikonfigurasi di server ini, jadi komunitas berbayar belum bisa dibuat"
      );
    }

    // Re-saving the community's own slug is fine; taking another's is not.
    if (input.patch.slug && input.patch.slug !== existing.slug) {
      if (await this.communities.slugExists(input.patch.slug)) {
        throw new ConflictError("slug is already taken");
      }
    }

    const updated = await this.communities.update(
      input.communityId,
      input.creatorId,
      input.patch
    );
    if (!updated) {
      throw new NotFoundError("community not found");
    }
    return updated;
  }
}
