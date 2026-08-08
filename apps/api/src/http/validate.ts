import type { Context, Next } from "hono";
import { z, type ZodRawShape, type ZodSchema } from "zod";
import { ValidationError } from "../application/errors";

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

/** A path segment that must be a UUID, e.g. `/communities/:id`. */
export const uuidParam = z.string().uuid();

/**
 * Parses PATH parameters against `schema`, storing the result under
 * `validatedParams`.
 *
 * Without this, a non-UUID id goes straight into a `where id = $1` comparison
 * and Postgres raises `invalid input syntax for type uuid` — an unhandled DB
 * error, and a 500, on trivially reachable client input that deserves a 400.
 *
 * Params are read by NAME from the schema's own keys rather than from
 * `c.req.param()` with no argument: on a sub-app mounted at
 * `/communities/:communityId/tiers`, a `use("*")` middleware sees only the
 * parent's params, so enumerating whatever happens to be present would silently
 * skip `:tierId`.
 */
export function validateParams<T extends ZodRawShape>(schema: z.ZodObject<T>) {
  const keys = Object.keys(schema.shape);
  return async (c: Context, next: Next) => {
    const raw: Record<string, string | undefined> = {};
    for (const key of keys) {
      raw[key] = c.req.param(key);
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new ValidationError(describeIssues(result.error));
    }

    c.set("validatedParams", result.data);
    await next();
  };
}

/**
 * Parses the JSON body against `schema`, storing the result under `validated`.
 * Retrieve it in the handler with `c.get("validated")`.
 */
export function validate(schema: ZodSchema) {
  return async (c: Context, next: Next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ValidationError("request body must be valid JSON");
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new ValidationError(describeIssues(result.error));
    }

    c.set("validated", result.data);
    await next();
  };
}
