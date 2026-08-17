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
}
