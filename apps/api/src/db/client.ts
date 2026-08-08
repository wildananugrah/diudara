import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });

/**
 * What a repository should accept in its constructor: either the pooled client
 * `db`, or an open transaction handle from `db.transaction(...)`.
 *
 * `PgTransaction` extends `PgDatabase`, so this common base is satisfied by
 * both, and a repository constructed against it cannot tell the difference.
 * That is what lets several repositories be composed into ONE atomic unit of
 * work (see `DrizzlePaymentActivationUnitOfWork`) without any repository
 * knowing it is inside a transaction, and without a union type whose call
 * signatures TypeScript would refuse to merge.
 */
export type DatabaseExecutor = PgDatabase<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
