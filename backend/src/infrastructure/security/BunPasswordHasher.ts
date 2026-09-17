import type { PasswordHasher } from "../../domain/ports.ts";

/** Bun ships argon2id natively, so this needs no bcrypt dependency. */
export class BunPasswordHasher implements PasswordHasher {
  hash(plain: string): Promise<string> {
    return Bun.password.hash(plain, { algorithm: "argon2id" });
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await Bun.password.verify(plain, hash);
    } catch {
      // A malformed stored hash must read as "wrong password", not crash the login route.
      return false;
    }
  }
}
