import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { creators } from "../../db/schema";
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
}
