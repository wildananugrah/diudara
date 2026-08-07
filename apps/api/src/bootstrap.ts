import { db } from "./db/client";
import { DrizzleCreatorRepository } from "./infrastructure/repositories/drizzle-creator.repository";

export function bootstrap() {
  const creatorRepository = new DrizzleCreatorRepository(db);

  return {
    creatorRepository,
  };
}

export type Dependencies = ReturnType<typeof bootstrap>;
