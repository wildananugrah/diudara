import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, queryClient } from "./client.ts";

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("[migrate] done");
await queryClient.end();
