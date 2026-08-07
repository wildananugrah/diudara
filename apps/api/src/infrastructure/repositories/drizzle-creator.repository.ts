import { eq } from "drizzle-orm";
import type { db as DbClient } from "../../db/client";
import { creators } from "../../db/schema";
import type {
  CreatorRecord,
  CreatorRepositoryPort,
} from "../../application/ports/creator-repository.port";

export class DrizzleCreatorRepository implements CreatorRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  async create(input: {
    name: string;
    whatsappNumber: string;
    email?: string;
  }): Promise<CreatorRecord> {
    const [row] = await this.db
      .insert(creators)
      .values({
        name: input.name,
        whatsappNumber: input.whatsappNumber,
        email: input.email,
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<CreatorRecord | null> {
    const [row] = await this.db.select().from(creators).where(eq(creators.id, id));
    return row ?? null;
  }

  async findByEmail(email: string): Promise<CreatorRecord | null> {
    const [row] = await this.db
      .select()
      .from(creators)
      .where(eq(creators.email, email))
      .limit(1);
    return row ?? null;
  }
}
