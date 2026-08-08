import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { creators } from "../../db/schema";
import { UniqueRule } from "../../application/errors";
import { rethrowUniqueViolation } from "./pg-errors";
import type {
  CreatorCredentials,
  CreatorRecord,
  CreatorRepositoryPort,
} from "../../application/ports/creator-repository.port";

// Columns returned by the general-purpose methods below. Deliberately excludes
// passwordHash: password hashes must never leave the repository layer (no endpoint
// may return password_hash), and CreatorRecord has no passwordHash field. Listing
// columns explicitly means the hash is never fetched from the database in the
// first place, not merely stripped afterwards. A later login/auth task that needs
// the hash for verification should add its own dedicated method with its own
// explicit column list, rather than widening this one.
const creatorColumns = {
  id: creators.id,
  name: creators.name,
  whatsappNumber: creators.whatsappNumber,
  email: creators.email,
  tierPlan: creators.tierPlan,
  xenditAccountId: creators.xenditAccountId,
  createdAt: creators.createdAt,
} as const;

export class DrizzleCreatorRepository implements CreatorRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    name: string;
    whatsappNumber?: string;
    email?: string;
    passwordHash?: string;
  }): Promise<CreatorRecord> {
    try {
      const [row] = await this.db
        .insert(creators)
        .values({
          name: input.name,
          whatsappNumber: input.whatsappNumber,
          email: input.email,
          passwordHash: input.passwordHash,
        })
        .returning(creatorColumns);
      return row;
    } catch (err) {
      // RegisterCreator's findByEmail pre-check is TOCTOU: two concurrent
      // signups for one address both see "free" and both insert. The partial
      // unique index is the real arbiter, so translate its violation here.
      // Letting it escape would land in the unhandled-error path, where the
      // driver error's bound parameters include the argon2id hash.
      rethrowUniqueViolation(err, {
        creator_email_unique: {
          rule: UniqueRule.creatorEmail,
          message: "email is already registered",
        },
      });
    }
  }

  async findById(id: string): Promise<CreatorRecord | null> {
    const [row] = await this.db
      .select(creatorColumns)
      .from(creators)
      .where(eq(creators.id, id));
    return row ?? null;
  }

  async findByEmail(email: string): Promise<CreatorRecord | null> {
    const [row] = await this.db
      .select(creatorColumns)
      .from(creators)
      .where(eq(creators.email, email))
      .limit(1);
    return row ?? null;
  }

  async findCredentialsByEmail(email: string): Promise<CreatorCredentials | null> {
    const [row] = await this.db
      .select({
        id: creators.id,
        name: creators.name,
        email: creators.email,
        passwordHash: creators.passwordHash,
      })
      .from(creators)
      .where(eq(creators.email, email))
      .limit(1);
    return row ?? null;
  }

  async setXenditAccountId(id: string, accountId: string): Promise<void> {
    await this.db
      .update(creators)
      .set({ xenditAccountId: accountId })
      .where(eq(creators.id, id));
  }
}
