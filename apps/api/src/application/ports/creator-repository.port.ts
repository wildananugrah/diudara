export interface CreatorRecord {
  id: string;
  name: string;
  whatsappNumber: string | null;
  email: string | null;
  tierPlan: string;
  createdAt: Date;
}

/**
 * The ONLY shape that carries the password hash. Returned exclusively by
 * findCredentialsByEmail, which exists so the login use-case can verify a
 * password without widening CreatorRecord — every other method projects a
 * column list that excludes password_hash entirely.
 * Never return this from an HTTP handler.
 */
export interface CreatorCredentials {
  id: string;
  name: string;
  email: string | null;
  passwordHash: string | null;
}

export interface CreatorRepositoryPort {
  create(input: {
    name: string;
    whatsappNumber?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<CreatorRecord>;
  findById(id: string): Promise<CreatorRecord | null>;
  findByEmail(email: string): Promise<CreatorRecord | null>;
  findCredentialsByEmail(email: string): Promise<CreatorCredentials | null>;
}
