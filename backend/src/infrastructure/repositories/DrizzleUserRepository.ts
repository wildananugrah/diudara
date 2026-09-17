import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import type { UserRepository } from "../../domain/ports.ts";
import type { User } from "../../domain/types.ts";

const toUser = (r: typeof users.$inferSelect): User => ({
  id: r.id, email: r.email, name: r.name,
  handle: r.handle, avatarColor: r.avatarColor, initials: r.initials,
});

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
  }

  async create(input: {
    email: string; passwordHash: string; name: string;
    handle: string; avatarColor: string; initials: string;
  }): Promise<User> {
    const [row] = await this.db.insert(users).values({ ...input, email: input.email.toLowerCase() }).returning();
    return toUser(row!);
  }
}
