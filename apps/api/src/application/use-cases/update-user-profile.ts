import { NotFoundError } from "../errors";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import { toOwnProfile, type OwnUserProfile } from "./get-user-profile";

/**
 * `PATCH /users/me`. `handle` is deliberately absent from the patch shape —
 * see `updateProfileSchema`'s own docstring in `@diudara/shared` for why a
 * `handle` in the request body is stripped, not honoured. `bio: undefined`
 * (the key absent) leaves the column untouched; `bio: null` (the key
 * present, value `null`) clears it. `DrizzleUserRepository.updateProfile`
 * is what actually distinguishes the two — this use-case just forwards
 * whatever the caller passed.
 */
export class UpdateUserProfile {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(input: {
    userId: string;
    patch: { displayName?: string; bio?: string | null; whatsappNumber?: string | null };
  }): Promise<OwnUserProfile> {
    const updated = await this.users.updateProfile(input.userId, input.patch);
    if (!updated) {
      throw new NotFoundError("user not found");
    }
    return toOwnProfile(updated);
  }
}
