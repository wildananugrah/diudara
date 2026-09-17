import type { Context, Next } from "hono";
import type { TokenIssuer } from "../domain/ports.ts";
import { DomainError, UnauthorizedError, ValidationError } from "../domain/errors.ts";

export type AppEnv = { Variables: { userId: string | null } };

/**
 * Resolves the caller if a valid token is present, but never rejects. Routes
 * state their own requirement via requireAuth, so a public route cannot
 * accidentally become private (or vice versa) by how it's mounted.
 */
export const authenticate = (tokens: TokenIssuer) => async (c: Context<AppEnv>, next: Next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const claims = token ? await tokens.verify(token) : null;
  c.set("userId", claims?.sub ?? null);
  await next();
};

export const requireAuth = async (c: Context<AppEnv>, next: Next) => {
  if (!c.get("userId")) throw new UnauthorizedError();
  await next();
};

/** Single place that turns a thrown domain error into an HTTP response. */
export const errorHandler = (err: Error, c: Context) => {
  if (err instanceof DomainError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  console.error("[unhandled]", err);
  return c.json({ error: { code: "internal_error", message: "Terjadi kesalahan pada server" } }, 500);
};

export const userId = (c: Context<AppEnv>): string => {
  const id = c.get("userId");
  if (!id) throw new UnauthorizedError();
  return id;
};

/**
 * `noUncheckedIndexedAccess` widens Hono's param() to `string | undefined`.
 * A route param is always present for a matched route, so this narrows it in
 * one place instead of a non-null assertion at every call site.
 */
export const param = (c: Context<AppEnv>, name: string): string => {
  const value = c.req.param(name);
  if (value === undefined) throw new ValidationError(`Parameter '${name}' tidak ada`);
  return value;
};
