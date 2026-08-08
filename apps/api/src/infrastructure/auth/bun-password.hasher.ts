import type { PasswordHasherPort } from "../../application/ports/password-hasher.port";

/** Uses Bun's built-in password hashing, which defaults to argon2id. */
export class BunPasswordHasher implements PasswordHasherPort {
  async hash(plain: string): Promise<string> {
    return Bun.password.hash(plain);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await Bun.password.verify(plain, hash);
    } catch {
      // A malformed or unrecognised hash is a failed verification, not a crash.
      return false;
    }
  }
}
