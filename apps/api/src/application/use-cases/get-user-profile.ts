import { NotFoundError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";

/**
 * `GET /users/by-handle/:handle`'s response shape. Anyone can fetch any
 * profile by handle, unauthenticated — so this is an EXPLICIT projection,
 * never a spread of `UserRecord`. `email` and `whatsappNumber` would be a far
 * worse leak here than the account-enumeration the rest of this phase
 * carefully avoids; `id` and `sessionEpoch` have no business being public at
 * all. Assert on `Object.keys(body).sort()` in route tests, not on this
 * type — TypeScript's structural typing accepts extra properties silently,
 * which is exactly how a previous phase's hash-exclusion mutation slipped
 * past both the suite and typecheck.
 */
export interface PublicUserProfile {
  handle: string;
  displayName: string;
  bio: string | null;
  createdAt: Date;
}

/**
 * `GET /users/me`'s response shape — the public projection above PLUS email
 * and WhatsApp number, because it is the authenticated caller's OWN record.
 * Still an explicit projection, not a spread: it must never carry
 * `passwordHash` (impossible anyway, since `UserRecord` never has it) or
 * `sessionEpoch`.
 */
export interface OwnUserProfile extends PublicUserProfile {
  email: string;
  whatsappNumber: string | null;
}

function toPublicProfile(user: UserRecord): PublicUserProfile {
  return {
    handle: user.handle,
    displayName: user.displayName,
    bio: user.bio,
    createdAt: user.createdAt,
  };
}

/** Exported so `UpdateUserProfile` projects its own result the same way. */
export function toOwnProfile(user: UserRecord): OwnUserProfile {
  return {
    ...toPublicProfile(user),
    email: user.email,
    whatsappNumber: user.whatsappNumber,
  };
}

export class GetUserProfile {
  constructor(private readonly users: UserRepositoryPort) {}

  /**
   * `GET /users/by-handle/:handle` — public, no auth. Takes a BARE handle;
   * the `@` some clients still type is a web URL convention only.
   * `normalizeHandle` strips one leading `@` before the lookup, so a mistake
   * here is forgiving rather than a 404.
   */
  async execute(rawHandle: string): Promise<PublicUserProfile> {
    const handle = normalizeHandle(rawHandle);
    const user = await this.users.findByHandle(handle);
    if (!user) {
      throw new NotFoundError("user not found");
    }
    return toPublicProfile(user);
  }

  /**
   * `GET /users/me` — the authenticated caller's own record, read by id.
   * `requireUserAuth` has already re-read this same row once (to check
   * `sessionEpoch`) before this ever runs; this is a second read rather than
   * threading that one through, mirroring how the rest of this codebase
   * keeps route middleware and use-cases independently testable.
   */
  async executeOwn(userId: string): Promise<OwnUserProfile> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundError("user not found");
    }
    return toOwnProfile(user);
  }
}
