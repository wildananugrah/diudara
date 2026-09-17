import type { Config } from "drizzle-kit";
import { env } from "./src/config/env.ts";

export default {
  schema: "./src/infrastructure/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: env.DATABASE_URL },
} satisfies Config;
