import type { FollowListRow } from "./follow-repository.port";

export interface UserRecord {
  id: string;
  handle: string;
  email: string;
  whatsappNumber: string | null;
  displayName: string;
  bio: string | null;
  sessionEpoch: number;
  createdAt: Date;
}

/**
 * The ONLY shape that carries the password hash. Returned exclusively by
 * `findCredentialsByEmail`, which exists so a login use-case can verify a
 * password without widening `UserRecord` — every other method on
 * `UserRepositoryPort` projects a column list that excludes password_hash
 * entirely. Never return this from an HTTP handler.
 */
export interface UserCredentials {
  id: string;
  passwordHash: string;
  sessionEpoch: number;
}

export interface UserRepositoryPort {
  /** Rejects with `UniqueViolationError` naming which of handle/email collided. */
  create(input: {
    handle: string;
    email: string;
    whatsappNumber: string | null;
    passwordHash: string;
    displayName: string;
  }): Promise<UserRecord>;
  findByHandle(handle: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** The ONLY path that returns a hash. `findBy*` deliberately never do. */
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  updateProfile(
    id: string,
    patch: { displayName?: string; bio?: string | null; whatsappNumber?: string | null }
  ): Promise<UserRecord | null>;
  setPasswordAndBumpEpoch(id: string, passwordHash: string): Promise<boolean>;
  /**
   * Prefix search over `handle` and `display_name`, case-insensitive.
   *
   * NEVER matches email or whatsapp_number. Phase 1 went to considerable lengths so
   * signup and password reset cannot be used to test whether an address is
   * registered — see that spec's §5.1. A search box that accepted an email address
   * would undo all of it in one line. Handles and display names are public by
   * design and already browsable at `/@handle`; addresses are not.
   *
   * `limit` follows `FollowRepositoryPort.listFollowers`'s contract exactly: a
   * non-positive or non-finite value yields ZERO rows rather than an unbounded
   * query.
   */
  searchPublic(query: string, limit: number): Promise<FollowListRow[]>;
  /** Newest accounts first (`created_at` descending). Same `limit` contract as `searchPublic`. */
  newestPublic(limit: number): Promise<FollowListRow[]>;
  /**
   * Most followers first, users with zero followers last. Same `limit`
   * contract as `searchPublic`.
   */
  mostFollowedPublic(limit: number): Promise<FollowListRow[]>;
}
