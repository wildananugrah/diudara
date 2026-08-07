import type { Context, Next } from "hono";
import type { ZodSchema } from "zod";
import { ValidationError } from "../application/errors";

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
      const detail = result.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      throw new ValidationError(detail);
    }

    c.set("validated", result.data);
    await next();
  };
}
